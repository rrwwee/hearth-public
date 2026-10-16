import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mac = (suffix) => ["02", "00", "00", "00", "00", suffix].join(":");
const device = (suffix) => ({ mac: mac(suffix), ip: `192.0.2.${parseInt(suffix, 16)}` });

async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function fixture(context, { enabled, network, config: overrides = {}, deliveryGate = Promise.resolve() }) {
  const root = await mkdtemp(join(tmpdir(), "hearth-presence-"));
  let child;
  let receiver;
  context.after(async () => {
    if (child) {
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    if (receiver) {
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  const config = join(root, "config");
  const state = join(root, "state");
  await mkdir(config);
  await mkdir(state);
  const observation = join(root, "network.json");
  await writeFile(observation, JSON.stringify(network));
  const messages = [];
  receiver = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    await deliveryGate;
    messages.push({ title: request.headers.title, body });
    response.end("ok");
  });
  const receiverPort = await listen(receiver);
  await writeFile(join(config, "notifications.json"), JSON.stringify({
    enabled, topic: "fixture", endpoint: `http://127.0.0.1:${receiverPort}`,
    pollMs: 1000, networkPollMs: 1000, ...overrides,
  }));
  await writeFile(join(config, "devices.json"), '{"devices":{}}');
  const agent = join(root, "agent");
  await writeFile(agent, `#!/usr/bin/env node
const fs = require("node:fs");
const command = process.argv[2];
if (command === "network") console.log(fs.readFileSync(process.env.FIXTURE_OBSERVATION, "utf8"));
else if (command === "cluster") console.log(JSON.stringify({reachable:true,user:"fixture",queries:{jobs:{status:"ok"}},jobs:[]}));
else if (command === "bluetooth") console.log(JSON.stringify({available:false,devices:[]}));
else process.exit(99);
`);
  await chmod(agent, 0o755);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      PATH: process.env.PATH, HOME: root,
      HEARTH_MODE: "live", HEARTH_BIND: "127.0.0.1", PORT: String(port),
      HEARTH_AGENT_MODE: "local", HEARTH_AGENT: agent,
      HEARTH_CONFIG_DIR: config, HEARTH_STATE_DIR: state,
      FIXTURE_OBSERVATION: observation,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await until(() => {
    if (child.exitCode !== null) throw new Error(output);
    return output.includes("live mode");
  }, "fixture server did not start");
  return {
    messages,
    namesPath: join(config, "devices.json"),
    eventsPath: join(state, "hearth-events.jsonl"),
    request: (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options),
    readState: () => readFile(join(state, "notification-state.json"), "utf8").then(JSON.parse).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
    network: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/network`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return (await response.json()).network;
    },
    setNetwork: async (value) => {
      await writeFile(`${observation}.tmp`, JSON.stringify(value));
      await rename(`${observation}.tmp`, observation);
    },
  };
}

test("manual label requests preserve responses and reject invalid configuration without replacement", async (context) => {
  const current = device("ab");
  const f = await fixture(context, { enabled: false, network: {
    timestamp: Math.floor(Date.now() / 1000), devices: [current],
  } });
  await writeFile(f.namesPath, JSON.stringify({ devices: {
    [current.mac.toUpperCase()]: "MAC label", [current.ip]: "IP label",
  }, extra: { keep: true } }));
  assert.equal((await f.network()).devices[0].nickname, "MAC label");
  const rename = (name) => f.request("/api/device-name", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: current.mac, mac: current.mac.toUpperCase(), ip: current.ip, name }),
  });
  const saved = await rename("  Office  ");
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true, keys: [current.mac, current.ip], name: "Office" });
  assert.deepEqual(JSON.parse(await readFile(f.namesPath, "utf8")), {
    devices: { [current.mac]: "Office", [current.ip]: "Office" }, extra: { keep: true },
  });
  for (const raw of ["{broken", '{"devices":[]}', '{"devices":{"label":false}}']) {
    await writeFile(f.namesPath, raw);
    const failed = await rename("Lost");
    assert.equal(failed.status, 400);
    assert.equal((await failed.json()).ok, false);
    const network = await f.request("/api/network");
    assert.equal(network.status, 502);
    assert.equal((await network.json()).ok, false);
    assert.equal(await readFile(f.namesPath, "utf8"), raw);
  }
  await rm(f.namesPath);
  await f.network();
  await assert.rejects(readFile(f.namesPath), { code: "ENOENT" });
  assert.equal((await rename("Recovered")).status, 200);
  assert.equal((await f.network()).devices[0].nickname, "Recovered");
  assert.equal((await rename("")).status, 200);
  assert.deepEqual(JSON.parse(await readFile(f.namesPath, "utf8")), { devices: {} });
});

test("inferred aliases preserve an existing manual label through the shared owner", async (context) => {
  const initial = Math.floor(Date.now() / 1000) - 120;
  const first = { ...device("ab"), nickname: "Inherited" };
  const second = device("ac");
  const f = await fixture(context, { enabled: true, network: { timestamp: initial, devices: [first] } });
  const observed = async (offset) => (await f.readState())?.networkObservedAt === (initial + offset) * 1000;
  await until(() => observed(0), "baseline was not committed");
  const response = await f.request("/api/device-name", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mac: second.mac, name: "Manual" }),
  });
  assert.equal(response.status, 200);
  await f.setNetwork({ timestamp: initial + 30, devices: [second] });
  await until(() => observed(30), "second address was not committed");
  assert.equal((await f.readState()).networkDevices[second.mac].inferredFrom, first.mac);
  assert.deepEqual(JSON.parse(await readFile(f.namesPath, "utf8")), { devices: { [second.mac]: "Manual" } });
});

test("failed inferred alias persistence retries before committing the observation", async (context) => {
  const initial = Math.floor(Date.now() / 1000) - 120;
  const first = { ...device("ab"), nickname: "Inherited" };
  const second = device("ac");
  const f = await fixture(context, { enabled: true, network: { timestamp: initial, devices: [first] } });
  const observed = async (offset) => (await f.readState())?.networkObservedAt === (initial + offset) * 1000;
  await until(() => observed(0), "baseline was not committed");
  const saved = { devices: { "192.0.2.250": "Independent" }, extra: { keep: true } };
  await writeFile(f.namesPath, JSON.stringify(saved));
  const beforeFailure = await readFile(f.namesPath, "utf8");
  await writeFile(f.namesPath, "{broken");
  await f.setNetwork({ timestamp: initial + 30, devices: [second] });
  await until(async () => (await readFile(f.eventsPath, "utf8")).includes("notify.network_monitor_error"),
    "alias persistence failure was not reported");
  assert.equal(await observed(0), true, "failed alias persistence must not advance the observation");
  assert.equal(await readFile(f.namesPath, "utf8"), "{broken");
  await writeFile(f.namesPath, beforeFailure);
  await until(() => observed(30), "observation did not recover after configuration repair");
  assert.deepEqual(JSON.parse(await readFile(f.namesPath, "utf8")), {
    devices: { ...saved.devices, [second.mac]: "Inherited" }, extra: { keep: true },
  });
});

test("disabled notifications leave tracking disabled while cached dashboard observations age", async (context) => {
  const timestamp = Math.floor(Date.now() / 1000) - 601;
  const f = await fixture(context, { enabled: false, network: { timestamp, devices: [device("01")] } });
  const view = await f.network();
  assert.equal(view.devices[0].status, "offline");
  assert.equal(view.devices[0].lastSeen, timestamp);
  assert.deepEqual(view.counts, { online: 0, offline: 1 });
  assert.equal(await f.readState(), null);
  assert.deepEqual(f.messages, []);
});

test("monitor and dashboard share observation times and confirm each arrival once", async (context) => {
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  context.after(() => releaseDelivery());
  const initial = Math.floor(Date.now() / 1000) - 120;
  const scan = (offset, devices) => ({ timestamp: initial + offset, devices });
  const f = await fixture(context, { enabled: true, network: scan(0, [device("01")]), deliveryGate });
  const observed = async (offset) => {
    const state = await f.readState();
    return state?.networkObservedAt === (initial + offset) * 1000 ? state : null;
  };
  await until(() => observed(0), "monitor did not save the baseline observation");
  assert.deepEqual(f.messages, [], "the initial baseline must be quiet");
  await f.setNetwork(scan(30, [device("01"), device("02")]));
  const pending = await until(() => observed(30), "monitor did not save the pending arrival");
  assert.equal(pending.networkDevices[mac("02")].pendingJoin, true);
  for (let index = 0; index < 3; index++) await f.network();
  await until(async () => (await f.readState())?.networkCheckedAt > pending.networkCheckedAt, "monitor did not repeat its scan");
  assert.deepEqual(f.messages, [], "repeated snapshots and dashboard reads must not confirm an arrival");
  await f.setNetwork(scan(60, [device("01"), device("02")]));
  const confirmed = await until(() => observed(60), "monitor did not save the confirmed arrival");
  assert.equal(confirmed.networkDevices[mac("02")].pendingJoin, false);
  assert.equal(confirmed.networkDevices[mac("02")].lastSeen, (initial + 60) * 1000);
  const view = await f.network();
  const newcomer = view.devices.find((d) => d.mac === mac("02"));
  assert.equal(newcomer.lastSeen, initial + 60);
  assert.equal(newcomer.onlineSince, initial + 30);
  assert.equal(confirmed.pending.filter((event) => event.kind === "network.first_seen").length, 1);
  assert.deepEqual(f.messages, [], "presence can be committed before notification delivery");
  releaseDelivery();
  await until(async () => {
    const state = await f.readState();
    return state && !state.pending.some((event) => event.kind === "network.first_seen");
  }, "monitor did not acknowledge the first-seen alert");
  assert.deepEqual(f.messages.map((message) => message.title), ["New device seen on the network"]);
});
