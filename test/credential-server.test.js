import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEnvironment } from "./fixtures/environment.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function credentialServer(context, helperSource) {
  const root = await mkdtemp(join(tmpdir(), "hearth-credential-output-"));
  const state = join(root, "state");
  const config = join(root, "config");
  const helper = join(root, "helper.mjs");
  const probe = join(root, "probe.mjs");
  await mkdir(state);
  await mkdir(config);
  await writeFile(join(config, "notifications.json"), '{"enabled":false}');
  await writeFile(helper, `#!${process.execPath}\n${helperSource}`);
  await chmod(helper, 0o755);
  // Fake only the external reachability boundary; the credential helper is real.
  await writeFile(probe, `import { Socket } from "node:net";
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (port, host, ...args) {
  if (host !== "credential-probe.invalid") return connect.call(this, port, host, ...args);
  queueMicrotask(() => this.emit("connect"));
  return this;
};\n`);
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ["--import", probe, "server.js"], {
    cwd: new URL("..", import.meta.url),
    env: fixtureEnvironment({
      HOME: root, PORT: String(port), HEARTH_MODE: "live", HEARTH_BIND: "127.0.0.1",
      HEARTH_AGENT_MODE: "local", HEARTH_AGENT: "/bin/false",
      HEARTH_STATE_DIR: state, HEARTH_CONFIG_DIR: config,
      HEARTH_VPN_HELPER: helper, HEARTH_CLUSTER_PROBE_HOST: "credential-probe.invalid",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  context.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => child.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("credential fixture did not start")), 5000);
    child.stdout.on("data", data => {
      if (data.toString().includes("live mode")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("credential fixture exited")); });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    async submit(password, target = "vpn") {
      const response = await fetch(`${base}/api/secret`, {
        method: "POST", headers: { "content-type": "application/json", "x-hearth-secret": "1", origin: base },
        body: JSON.stringify({ target, password }), signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, body: await response.json() };
    },
    async diagnostics(traceId) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`${base}/api/diagnostics`, { headers: { origin: base } });
        const { diagnostics: payload } = await response.json();
        if (payload.events.some(event => event.event === "secret.close" && (!traceId || event.traceId === traceId))) {
          return { events: payload.events, persisted: await readFile(join(state, "hearth-events.jsonl"), "utf8") };
        }
        await delay(10);
      }
      throw new Error("credential fixture did not record completion");
    },
  };
}

test("credential failures redact passwords echoed across real subprocess chunks", async context => {
  const fixture = await credentialServer(context, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.slice(0, -1);
process.stdout.write("authentication failed: " + password.slice(0, 8));
await new Promise(resolve => setTimeout(resolve, 80));
process.stdout.write(password.slice(8) + "\\nuse a new ticket\\n");
process.exitCode = 1;
`);
  const password = "synthetic-credential-only";
  const result = await fixture.submit(password);
  const diagnostics = await fixture.diagnostics();
  assert.equal(result.status, 400);
  assert.equal(result.body.error.includes(password), false, "HTTP error exposed the synthetic credential");
  assert.equal(JSON.stringify(diagnostics).includes(password), false, "diagnostics exposed the synthetic credential");
  assert.equal(result.body.error.includes("use a new ticket"), true);
});

test("credential diagnostics redact matches created by NUL normalization", async context => {
  const fixture = await credentialServer(context, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.slice(0, -1);
process.stderr.write("failure: " + password.slice(0, 6) + "\\0" + password.slice(6) + "\\nuse a new ticket");
process.exitCode = 1;
`);
  const password = "synthetic-normalization-only";
  const result = await fixture.submit(password);
  const diagnostics = await fixture.diagnostics();
  assert.equal(result.status, 400);
  assert.equal(JSON.stringify(diagnostics).includes(password), false, "normalized diagnostics exposed a credential");
  assert.ok(result.body.error.endsWith("use a new ticket"));
});

test("final credential responses guard generated success and error messages", async context => {
  const fixture = await credentialServer(context, "process.stdin.resume();");
  const success = await fixture.submit("start");
  assert.equal(success.status, 200);
  assert.equal(success.body.message.includes("start"), false, "generated success message reproduced a credential");
  const programCollision = await fixture.submit("helper");
  assert.equal(programCollision.status, 200);
  const { events } = await fixture.diagnostics(programCollision.body.traceId);
  const commandEvents = events.filter(event => event.traceId === programCollision.body.traceId && event.program);
  assert.ok(commandEvents.length > 0);
  assert.equal(commandEvents.some(event => event.program.includes("helper")), false, "logged program reproduced a credential");
  const failure = await fixture.submit("password", "unknown");
  assert.equal(failure.status, 400);
  assert.equal(failure.body.error.includes("password"), false, "generated error message reproduced a credential");
});

test("successful credential commands protect both streams and preserve stdin-only delivery", async context => {
  const fixture = await credentialServer(context, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.slice(0, -1);
if (process.argv.some(arg => arg.includes(password)) || Object.values(process.env).some(value => value.includes(password))) {
  process.exitCode = 2;
} else {
  const bytes = Buffer.from(password);
  process.stdout.write(bytes.subarray(0, 10));
  process.stderr.write(bytes.subarray(0, 10));
  await new Promise(resolve => setTimeout(resolve, 50));
  process.stdout.write(Buffer.concat([bytes.subarray(10), Buffer.from("\\nstdin accepted")]));
  process.stderr.write(Buffer.concat([bytes.subarray(10), Buffer.from("\\nstderr retained")]));
}
`);
  const password = "fixture-🔑-成功";
  const result = await fixture.submit(password);
  const diagnostics = await fixture.diagnostics();
  assert.equal(result.status, 200);
  const close = diagnostics.events.find(event => event.event === "secret.close");
  assert.equal(close.stdout, "[redacted]\nstdin accepted");
  assert.equal(close.stderr, "[redacted]\nstderr retained");
  assert.equal(JSON.stringify(diagnostics).includes(password), false, "successful command diagnostics exposed a credential");
});

test("nonzero credential exits preserve stderr precedence and mask unfinished echoes", async context => {
  const fixture = await credentialServer(context, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.slice(0, -1);
process.stdout.write(password + " unused stdout");
process.stderr.write("stderr failure: " + password.slice(0, 8));
await new Promise(resolve => setTimeout(resolve, 50));
process.stderr.write(password.slice(8) + "\\nunfinished: " + password.slice(0, 12) + "\\n");
process.exitCode = 1;
`);
  const password = "synthetic-stderr-only";
  const result = await fixture.submit(password);
  const diagnostics = await fixture.diagnostics();
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "stderr failure: [redacted]\nunfinished: [redacted]");
  assert.equal(JSON.stringify(diagnostics).includes(password), false, "stderr diagnostics exposed a credential");
});

test("verbose credential commands drain to completion with bounded redacted tails", async context => {
  const fixture = await credentialServer(context, `
import { once } from "node:events";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.slice(0, -1);
for (let index = 0; index < 512; index++) {
  if (!process.stdout.write("x".repeat(4096))) await once(process.stdout, "drain");
}
process.stdout.write(password.slice(0, 8));
await new Promise(resolve => setTimeout(resolve, 50));
process.stdout.write(password.slice(8) + "\\nfinal useful failure");
process.exitCode = 1;
`);
  const password = "synthetic-large-output";
  const result = await fixture.submit(password);
  const diagnostics = await fixture.diagnostics();
  assert.equal(result.status, 400);
  assert.ok(Buffer.byteLength(result.body.error) <= 65536);
  assert.ok(result.body.error.startsWith("[earlier output omitted]\n"));
  assert.ok(result.body.error.endsWith("[redacted]\nfinal useful failure"));
  const close = diagnostics.events.find(event => event.event === "secret.close");
  assert.equal(Array.from(close.stdout).length, 1200);
  assert.ok(close.stdout.startsWith("[earlier output omitted]\n"));
  assert.ok(close.stdout.endsWith("[redacted]\nfinal useful failure"));
  assert.equal(JSON.stringify({ result, diagnostics }).includes(password), false, "large output exposed a credential");
});
