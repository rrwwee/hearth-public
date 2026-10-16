import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEnvironment } from "./fixtures/environment.js";

async function fixture(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "hearth-access-"));
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const name of ["config", "state"]) await mkdir(join(root, name));
  for (const name of ["cluster.example.json", "ntfy-server.example.yml"]) {
    await copyFile(new URL(`../pi/dashboard/config/${name}`, import.meta.url), join(root, "config", name.replace(".example", "")));
  }
  await writeFile(join(root, "config", "notifications.json"), '{"enabled":false}');
  await writeFile(join(root, "config", "devices.json"), '{"devices":{}}');
  const agent = join(root, "agent");
  await writeFile(agent, `#!${process.execPath}\nconsole.log(JSON.stringify({devices:[],available:false}));\n`);
  await chmod(agent, 0o755);
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = fixtureEnvironment({ HEARTH_MODE: "live", PORT: String(port), HEARTH_AGENT_MODE: "local",
    HEARTH_AGENT: agent, HEARTH_CONFIG_DIR: join(root, "config"), HEARTH_STATE_DIR: join(root, "state"), ...settings });

  const launch = async (overrides = {}, validate = false, expectExit = false) => {
    const child = spawn(process.execPath, ["server.js"], { cwd: new URL("..", import.meta.url),
      env: { ...env, ...overrides, ...(validate ? { HEARTH_VALIDATE_ONLY: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise((resolve) => child.once("exit", (code) => { children.delete(child); resolve({ code, output }); }));
    if (validate || expectExit) return done;
    const deadline = Date.now() + 5000;
    while (!output.includes(" mode)")) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture did not start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { output };
  };
  const request = (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("Fixture request timed out")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { launch, request, port, state: join(root, "state") };
}

test("all protected HTTP handlers enforce the configured proxy contract", async (t) => {
  const f = await fixture(t, { HEARTH_TRUSTED_PROXIES: "127.0.0.1", HEARTH_ALLOWED_ORIGINS: "https://hearth.example.invalid" });
  await f.launch();
  for (const [path, method, status] of [["/api/diagnostics", "GET", 403], ["/api/device-name", "POST", 400], ["/api/secret", "POST", 400]]) {
    const response = await f.request(path, { method, headers: { host: "hearth.example.invalid", "x-hearth-secret": "1" } });
    assert.equal(response.status, status);
    assert.match(response.body.error, /proxy metadata/i, path);
  }
});

test("direct local access defaults to loopback and preserves endpoint restrictions", async (t) => {
  const f = await fixture(t);
  const running = await f.launch();
  assert.match(running.output, /http:\/\/127\.0\.0\.1:/);
  assert.equal((await f.request("/api/diagnostics")).status, 200);
  const saved = await f.request("/api/device-name", { method: "POST", body: { ip: "192.0.2.10", name: "Fixture" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.name, "Fixture");
  const missingHeader = await f.request("/api/secret", { method: "POST", body: {} });
  assert.match(missingHeader.body.error, /X-Hearth-Secret/);
  const emptyPassword = await f.request("/api/secret", { method: "POST", headers: { "x-hearth-secret": "1" }, body: {} });
  assert.equal(emptyPassword.body.error, "Password is required.");
  for (const [path, method, status] of [["/api/diagnostics", "GET", 403], ["/api/device-name", "POST", 400], ["/api/secret", "POST", 400]]) {
    const rejected = await f.request(path, { method, headers: { origin: `https://127.0.0.1:${f.port}`, "x-hearth-secret": "1" } });
    assert.equal(rejected.status, status);
    assert.match(rejected.body.error, /Origin/);
  }
});

test("private proxy HTTPS works while ambiguous metadata and destinations fail", async (t) => {
  const f = await fixture(t, { HEARTH_TRUSTED_PROXIES: "127.0.0.1", HEARTH_ALLOWED_ORIGINS: "https://hearth.example.invalid" });
  await f.launch();
  const headers = { host: "hearth.example.invalid", "x-forwarded-proto": "https", origin: "https://hearth.example.invalid" };
  assert.equal((await f.request("/api/diagnostics", { headers })).status, 200);
  assert.equal((await f.request("/api/device-name", { method: "POST", headers, body: { ip: "192.0.2.10", name: "Fixture" } })).status, 200);
  for (const scheme of ["http", "https,http", "HTTPS"]) {
    const response = await f.request("/api/diagnostics", { headers: { ...headers, "x-forwarded-proto": scheme } });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /proxy metadata/);
  }
  const duplicate = await f.request("/api/diagnostics", { headers: ["Host", "hearth.example.invalid", "X-Forwarded-Proto", "https", "X-Forwarded-Proto", "https"] });
  assert.equal(duplicate.status, 403);
  assert.match(duplicate.body.error, /proxy metadata/);
  const origin = await f.request("/api/diagnostics", { headers: { ...headers, origin: "http://hearth.example.invalid" } });
  assert.match(origin.body.error, /Origin/);
  const destination = await f.request("/api/diagnostics", { headers: { ...headers, host: "evil.invalid", "x-forwarded-host": "hearth.example.invalid" } });
  assert.match(destination.body.error, /destination/);
  for (const endpoint of ["/api/health", "/api/snapshot"]) {
    assert.equal((await f.request(endpoint, { headers: { host: "elsewhere.invalid" } })).status, 200);
  }
});

test("invalid access configuration fails runtime and validation without revealing values or writing state", async (t) => {
  const f = await fixture(t);
  for (const settings of [{ HEARTH_TRUSTED_CLIENTS: "private-do-not-print.invalid" }, { HEARTH_TRUSTED_PROXIES: "private-do-not-print.invalid" },
    { HEARTH_ALLOWED_ORIGINS: "https://private-do-not-print.invalid/path" }]) {
    for (const validate of [false, true]) {
      const result = await f.launch(settings, validate, true);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /configuration/);
      assert.doesNotMatch(result.output, /private-do-not-print/);
    }
  }
  assert.equal((await f.launch({}, true)).code, 0);
  assert.deepEqual(await readdir(f.state), []);
});

test("demo ignores private access settings and keeps mutations isolated", async (t) => {
  const f = await fixture(t, { HEARTH_MODE: "demo", HEARTH_TRUSTED_PROXIES: "invalid", HEARTH_ALLOWED_ORIGINS: "invalid" });
  await f.launch();
  for (const path of ["/api/secret", "/api/device-name"]) {
    const response = await f.request(path, { method: "POST", headers: { "x-hearth-secret": "1" }, body: {} });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /disabled in demo mode/);
  }
});

test("malformed Host is rejected without terminating the server", async (t) => {
  const f = await fixture(t);
  await f.launch();
  const rejected = await f.request("/api/diagnostics", { headers: { host: "[invalid" } });
  assert.equal(rejected.status, 403);
  assert.match(rejected.body.error, /destination/);
  assert.equal((await f.request("/api/health")).status, 200);
});
