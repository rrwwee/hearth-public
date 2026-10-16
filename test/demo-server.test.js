import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEnvironment } from "./fixtures/environment.js";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("demo server did not start")), 5000);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      if (!chunk.toString().includes("demo mode")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`demo server exited with ${code}: ${stderr}`));
    });
  });
}

test("demo server is fixture-only and rejects credential actions", async (context) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: fixtureEnvironment({
      HEARTH_MODE: "demo",
      HEARTH_BIND: "127.0.0.1",
      PORT: String(port),
      HEARTH_HOST: "must-not-be-contacted.invalid",
      HEARTH_AGENT: "/bin/false",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);

  const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(health, { ok: true, mode: "demo", release: "development" });

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="\/app\.js")[^>]*>/);
  for (const asset of ["app.js", "cluster-credential-policy.js"]) {
    const response = await fetch(`http://127.0.0.1:${port}/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/javascript/);
    assert.equal(await response.text(), await readFile(new URL(`../public/${asset}`, import.meta.url), "utf8"));
  }

  for (const endpoint of ["snapshot", "network", "bluetooth", "cluster"]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/${endpoint}`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "demo");
    assert.ok(payload[endpoint]);
  }

  const secretResponse = await fetch(`http://127.0.0.1:${port}/api/secret`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hearth-secret": "1" },
    body: JSON.stringify({ target: "cluster", password: "fixture-only" }),
  });
  const secretPayload = await secretResponse.json();
  assert.equal(secretResponse.ok, false);
  assert.equal(secretPayload.ok, false);
  assert.match(secretPayload.error, /disabled in demo mode/i);
});

test("live mode fails closed when required configuration is absent", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, HEARTH_MODE: "live" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await new Promise((resolve) => child.once("exit", (...args) => resolve(args)));
  assert.notEqual(code, 0);
  assert.match(stderr, /required when HEARTH_MODE=live/);
});

test("validation-only live mode reads configuration without running adapters or writing state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "hearth-live-validation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const agentPath = join(root, "agent.sh");
  await mkdir(configDir);
  await mkdir(stateDir);
  await writeFile(agentPath, "#!/usr/bin/env sh\nexit 99\n", "utf8");
  await chmod(agentPath, 0o755);
  await writeFile(join(configDir, "devices.json"), JSON.stringify({ devices: { "192.0.2.10": "fixture host" } }), "utf8");
  await writeFile(join(configDir, "notifications.json"), JSON.stringify({ enabled: false }), "utf8");
  await writeFile(join(configDir, "cluster.json"), JSON.stringify({
    scheduler: "slurm",
    sshHost: "compute",
    jumpHost: "cluster-jump",
    user: "researcher",
    friends: [],
    jobLimit: 100,
  }), "utf8");
  await writeFile(join(configDir, "ntfy-server.yml"), "base-url: https://notify.example.invalid\nlisten-http: :2586\ncache-duration: 72h\n", "utf8");

  const validate = async () => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: new URL("..", import.meta.url),
      env: {
        PATH: process.env.PATH,
        HEARTH_MODE: "live",
        HEARTH_VALIDATE_ONLY: "1",
        HEARTH_AGENT_MODE: "local",
        HEARTH_AGENT: agentPath,
        HEARTH_STATE_DIR: stateDir,
        HEARTH_CONFIG_DIR: configDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await new Promise((resolve) => child.once("exit", (...args) => resolve(args)));
    return { code, stdout, stderr };
  };

  const { code, stdout, stderr } = await validate();
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Live configuration validation passed/);
  assert.deepEqual(await readdir(stateDir), []);
  const devicesPath = join(configDir, "devices.json");
  await rm(devicesPath);
  const missing = await validate();
  assert.equal(missing.code, 0, missing.stderr);
  await assert.rejects(readFile(devicesPath), { code: "ENOENT" });
  for (const invalid of ["{broken", '{"devices":[]}', '{"devices":{"label":42}}']) {
    await writeFile(devicesPath, invalid);
    const failed = await validate();
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /Device configuration/);
    assert.equal(await readFile(devicesPath, "utf8"), invalid);
  }
  assert.deepEqual(await readdir(stateDir), []);
});
