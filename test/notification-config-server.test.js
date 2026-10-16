import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hearth-config-server-"));
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(async ({ child, done }) => { child.kill("SIGTERM"); await done; }));
    await rm(root, { recursive: true, force: true });
  });
  const state = join(root, "state");
  const config = join(root, "config");
  await mkdir(state);
  await mkdir(config);
  for (const name of ["devices", "cluster"]) {
    await copyFile(new URL(`../pi/dashboard/config/${name}.example.json`, import.meta.url), join(config, `${name}.json`));
  }
  await copyFile(new URL("../pi/dashboard/config/ntfy-server.example.yml", import.meta.url), join(config, "ntfy-server.yml"));
  const agent = join(root, "agent");
  const fixtureMac = ["02", "00", "00", "00", "00", "01"].join(":");
  await writeFile(agent, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(join(root, "agent-calls"))}, process.argv[2] + "\\n");
console.log(JSON.stringify({timestamp: Math.floor(Date.now()/1000)-120, devices: [{mac:${JSON.stringify(fixtureMac)},ip:"192.0.2.1"}]}));
`);
  await chmod(agent, 0o755);
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = { PATH: process.env.PATH, HEARTH_MODE: "live", HEARTH_BIND: "127.0.0.1", PORT: String(port),
    HEARTH_AGENT_MODE: "local", HEARTH_AGENT: agent, HEARTH_CONFIG_DIR: config, HEARTH_STATE_DIR: state };
  const launch = (validate = false) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: new URL("..", import.meta.url), env: { ...env, ...(validate ? { HEARTH_VALIDATE_ONLY: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, output })));
    const running = { child, done, output: () => output };
    children.add(running);
    void done.then(() => children.delete(running));
    return running;
  };
  return { root, state, config, path: join(config, "notifications.json"), launch,
    write: (value) => writeFile(join(config, "notifications.json"), JSON.stringify(value)),
    request: (path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) }) };
}

test("live validation shares missing-file, disabled, and invalid configuration semantics without side effects", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.launch(true).done).code, 0, "missing notification configuration is disabled");
  for (const value of [null, [], {}, { enabled: false, pollMs: -1 }, { enabled: true, topic: "fixture" }]) {
    await f.write(value);
    const result = await f.launch(true).done;
    assert.notEqual(result.code, 0, JSON.stringify(value));
    assert.match(result.output, /Notification configuration/);
  }
  await f.write({ enabled: false });
  assert.equal((await f.launch(true).done).code, 0);
  await f.write({ enabled: true, endpoint: "http://127.0.0.1:9", topic: "fixture" });
  assert.equal((await f.launch(true).done).code, 0);
  assert.deepEqual(await readdir(f.state), []);
  await assert.rejects(readFile(join(f.root, "agent-calls")), { code: "ENOENT" });
});

test("invalid startup keeps the dashboard available and presence retains only valid policy", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, '{"token":"do-not-print",');
  const running = f.launch();
  for (let attempt = 0; !running.output().includes("live mode"); attempt++) {
    assert.ok(attempt < 200 && running.child.exitCode === null, running.output());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await f.request("/api/health")).status, 200);
  const network = async () => {
    const response = await f.request("/api/network");
    assert.equal(response.status, 200);
    return (await response.json()).network;
  };
  assert.equal((await network()).devices[0].status, "online");
  await f.write({ enabled: false, networkOnlineGraceMs: 1000 });
  assert.equal((await network()).devices[0].status, "offline");
  await writeFile(f.path, '{"token":"do-not-print",');
  assert.equal((await network()).devices[0].status, "offline");
  assert.equal((await network()).devices[0].status, "offline");
  await rm(f.path);
  assert.equal((await network()).devices[0].status, "online");
  const diagnostics = await (await f.request("/api/diagnostics")).json();
  const events = diagnostics.diagnostics.events;
  assert.deepEqual(events.filter((event) => event.event.startsWith("notify.config_")).map((event) => event.event),
    ["notify.config_error", "notify.config_recovered", "notify.config_error", "notify.config_recovered"]);
  assert.doesNotMatch(JSON.stringify(diagnostics) + running.output(), /do-not-print/);
  await assert.rejects(readFile(join(f.state, "notification-state.json")), { code: "ENOENT" });
});
