import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fixtureMac = (last) => [0, 17, 34, 51, 68, last].map((part) => part.toString(16).padStart(2, "0")).join(":");
const knownMac = fixtureMac(85);
const visitorMac = fixtureMac(86);

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fixture condition timed out");
}

test("server delivers network alert despite cluster delivery failure and preserves dashboard state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hearth-notify-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const config = join(root, "config");
  await mkdir(state);
  await mkdir(config);
  const received = [];
  let acceptCluster = false;
  const transport = createServer((request, response) => {
    received.push(request.headers);
    request.resume();
    response.writeHead(!acceptCluster && request.headers.title === "Cluster job started" ? 503 : 200);
    response.end();
  });
  t.after(() => new Promise((resolve) => transport.close(resolve)));
  const transportPort = await listen(transport);
  const portReservation = createServer();
  const port = await listen(portReservation);
  await new Promise((resolve) => portReservation.close(resolve));
  const now = Date.now();
  const devices = [
    { mac: knownMac, ip: "192.0.2.10", nickname: "known" },
    { mac: visitorMac, ip: "192.0.2.20", nickname: "visitor" },
  ];
  const agent = join(root, "agent");
  await writeFile(agent, `#!${process.execPath}\nconst fixtures = ${JSON.stringify({
    cluster: { reachable: true, user: "researcher", queries: { jobs: { status: "ok" } },
      jobs: [{ id: "42", user: "researcher", state: "RUNNING" }] },
    network: { devices, timestamp: Math.floor(now / 1000) },
    bluetooth: { available: false, devices: [] },
  })};\nconst result = fixtures[process.argv[2]]; if (!result) process.exit(99); console.log(JSON.stringify(result));\n`);
  await chmod(agent, 0o755);
  await writeFile(join(config, "notifications.json"), JSON.stringify({
    enabled: true, endpoint: `http://127.0.0.1:${transportPort}`, topic: "fixture", pollMs: 60000,
  }));
  await writeFile(join(state, "notification-state.json"), JSON.stringify({
    initialized: true, jobNotificationVersion: 3, knownTerminalJobs: {}, jobs: { "42": { id: "42", state: "PENDING" } },
    networkTrackingVersion: 4, networkCheckedAt: now - 60000,
    networkDevices: Object.fromEntries(devices.map((device, i) => [device.mac, {
      ...device, key: device.mac, present: true, lastSeen: (Math.floor(now / 1000) - 60) * 1000, seenScans: 1,
      pendingJoin: i === 1, firstSeen: i === 1,
    }])),
  }));
  const launch = () => spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HEARTH_MODE: "live", HEARTH_BIND: "127.0.0.1", PORT: String(port),
      HEARTH_AGENT_MODE: "local", HEARTH_AGENT: agent, HEARTH_CONFIG_DIR: config, HEARTH_STATE_DIR: state },
  });
  let child = launch();
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
  });
  await until(() => received.some((headers) => headers.title === "New device seen on the network"));
  await until(async () => JSON.parse(await readFile(join(state, "notification-state.json"), "utf8")).pending?.length === 1);
  assert.equal(child.exitCode, null, stderr);
  assert.equal(received.filter((headers) => headers.title === "Cluster job started").length, 1);
  assert.ok(received.every((headers) => headers["x-sequence-id"]?.startsWith("hearth-")));
  const response = await fetch(`http://127.0.0.1:${port}/api/network`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).network.devices.find((device) => device.mac === devices[1].mac).nickname, "visitor");
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  acceptCluster = true;
  child = launch();
  child.stderr.on("data", (data) => { stderr += data; });
  await until(async () => JSON.parse(await readFile(join(state, "notification-state.json"), "utf8")).pending?.length === 0);
  assert.equal(received.filter((headers) => headers.title === "New device seen on the network").length, 1);
  const clusterAttempts = received.filter((headers) => headers.title === "Cluster job started");
  assert.equal(clusterAttempts.length, 2);
  assert.equal(clusterAttempts[0]["x-sequence-id"], clusterAttempts[1]["x-sequence-id"]);
});
