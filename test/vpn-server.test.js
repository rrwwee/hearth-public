import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a blocked startup child is killed at the deadline and a later request can retry", { timeout: 20000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "hearth-vpn-deadline-"));
  for (const name of ["bin", "config", "state"]) await mkdir(join(root, name));
  await writeFile(join(root, "config/notifications.json"), '{"enabled":false}');
  const blocked = join(root, "blocked");
  const dnsPidFile = join(root, "dns.pid");
  await writeFile(blocked, "yes");
  const dns = join(root, "bin/getent");
  // Ignore TERM so the test also requires escalation to reap a stuck child.
  await writeFile(dns, `#!/usr/bin/env python3
import os, pathlib, signal, time
pathlib.Path(os.environ["VPN_TEST_DNS_PID"]).write_text(str(os.getpid()))
if pathlib.Path(os.environ["VPN_TEST_BLOCKED"]).exists():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(30)
raise SystemExit(1)
`);
  await chmod(dns, 0o755);
  await writeFile(join(root, "bin/flock"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "bin/flock"), 0o755);
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url), detached: true,
    env: {
      PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root,
      HEARTH_MODE: "live", HEARTH_BIND: "127.0.0.1", PORT: String(port),
      HEARTH_AGENT_MODE: "local", HEARTH_AGENT: "/bin/false",
      HEARTH_STATE_DIR: join(root, "state"), HEARTH_CONFIG_DIR: join(root, "config"),
      HEARTH_ENV_FILE: join(root, "absent"), HEARTH_VPN_HOST: "vpn.example.invalid",
      HEARTH_VPN_PORT: "443", HEARTH_VPN_USER: "fixture",
      HEARTH_VPN_HELPER: new URL("../pi/dashboard/start-vpn-from-stdin.sh", import.meta.url).pathname,
      HEARTH_CLUSTER_PROBE_HOST: "probe.example.invalid",
      VPN_TEST_DNS_PID: dnsPidFile, VPN_TEST_BLOCKED: blocked,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(async () => {
    const pid = Number(await readFile(dnsPidFile, "utf8").catch(() => ""));
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 5000);
    child.stdout.on("data", (data) => {
      if (data.toString().includes("live mode")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("server exited")); });
  });
  const connect = () => fetch(`http://127.0.0.1:${port}/api/secret`, {
    method: "POST", headers: { "content-type": "application/json", "x-hearth-secret": "1" },
    body: JSON.stringify({ target: "vpn", password: "fixture-only" }),
    signal: AbortSignal.timeout(9000),
  });
  const first = await connect();
  assert.equal(first.status, 400);
  assert.match((await first.json()).error, /timed out/);
  const pid = Number(await readFile(dnsPidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await rm(blocked);
  const retry = await connect();
  assert.equal(retry.status, 400);
  const error = (await retry.json()).error;
  assert.doesNotMatch(error, /already in progress|timed out/);
  assert.match(error, /physical VPN gateway route/);
});

test("dashboard rejects overlap through the readiness probe and allows retry afterward", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "hearth-vpn-server-"));
  const config = join(root, "config");
  const state = join(root, "state");
  const helper = join(root, "vpn-helper.sh");
  const launches = join(root, "launches");
  const gate = join(root, "continue");
  const probeStarted = join(root, "probe-started");
  const probeGate = join(root, "probe-continue");
  const preload = join(root, "probe.mjs");
  await mkdir(config);
  await mkdir(state);
  await writeFile(join(config, "notifications.json"), '{"enabled":false}');
  await writeFile(helper, '#!/usr/bin/env bash\nIFS= read -r secret\nprintf "started\\n" >> "$VPN_TEST_LAUNCHES"\nwhile [ ! -f "$VPN_TEST_GATE" ]; do sleep 0.01; done\n');
  await chmod(helper, 0o755);
  // Hold only the fixture probe; no real DNS or network connection is attempted.
  await writeFile(preload, `import { Socket } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (port, host, ...args) {
  if (host !== "cluster-probe.invalid") return connect.call(this, port, host, ...args);
  writeFileSync(${JSON.stringify(probeStarted)}, "started");
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(probeGate)})) return;
    clearInterval(timer);
    this.emit("timeout");
  }, 10);
  this.once("close", () => clearInterval(timer));
  return this;
};
`);
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ["--import", preload, "server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      PATH: process.env.PATH,
      HEARTH_MODE: "live", HEARTH_BIND: "127.0.0.1", PORT: String(port),
      HEARTH_AGENT_MODE: "local", HEARTH_AGENT: "/bin/false",
      HEARTH_STATE_DIR: state, HEARTH_CONFIG_DIR: config,
      HEARTH_VPN_HELPER: helper, HEARTH_CLUSTER_PROBE_HOST: "cluster-probe.invalid",
      VPN_TEST_LAUNCHES: launches, VPN_TEST_GATE: gate,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(async () => {
    await writeFile(gate, "go");
    await writeFile(probeGate, "go");
    child.kill("SIGTERM");
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("live server did not start")), 5000);
    child.stdout.on("data", (data) => {
      if (data.toString().includes("live mode")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
  });
  const connect = () => fetch(`http://127.0.0.1:${port}/api/secret`, {
    method: "POST", headers: { "content-type": "application/json", "x-hearth-secret": "1" },
    body: JSON.stringify({ target: "vpn", password: "fixture-only" }),
    signal: AbortSignal.timeout(5000),
  });
  const first = connect();
  first.catch(() => {});
  for (let i = 0; i < 100; i++) {
    if (await readFile(launches, "utf8").catch(() => "")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await writeFile(gate, "go");
  for (let i = 0; i < 100; i++) {
    if (await readFile(probeStarted, "utf8").catch(() => "")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(probeStarted, "utf8"), "started");
  let firstSettled = false;
  first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  const second = connect();
  second.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    assert.equal((await readFile(launches, "utf8")).trim().split("\n").length, 1);
    const busy = await second;
    assert.equal(busy.status, 400);
    assert.match((await busy.json()).error, /already in progress/);
    assert.equal(firstSettled, false, "the first request must still be probing");
  } finally {
    await writeFile(probeGate, "go");
  }
  const unverified = await first;
  assert.equal(unverified.status, 400);
  assert.match((await unverified.json()).error, /VPN process started; cluster access not yet verified/);
  const retry = await connect();
  assert.equal(retry.status, 400);
  assert.match((await retry.json()).error, /not yet verified/);
  assert.equal((await readFile(launches, "utf8")).trim().split("\n").length, 2);
});
