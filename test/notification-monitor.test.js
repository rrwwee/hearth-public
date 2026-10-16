import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationMonitor } from "../lib/notification-monitor.js";
import { createNotificationStateStore } from "../lib/notification-state.js";
import { credentialObservations } from "./fixtures/cluster-credentials.js";

const fixtureMac = (last) => [0, 17, 34, 51, 68, last].map((part) => part.toString(16).padStart(2, "0")).join(":");
const knownMac = fixtureMac(85);
const visitorMac = fixtureMac(86);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hearth-monitor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createNotificationStateStore(join(root, "state.json"));
  const f = {
    store, path: join(root, "state.json"), now: Date.UTC(2026, 9, 11, 12), calls: [], sent: [],
    cluster: { reachable: true, user: "researcher", queries: { jobs: { status: "ok" } },
      jobs: [], accountingAvailable: true, terminalJobs: [] },
    network: { devices: [] },
    config: { enabled: true, topic: "fixture", endpoint: "https://notify.invalid", pollMs: 30000,
      networkPollMs: 30000, networkJoinScans: 2, networkAwayMs: 2700000,
      networkIdentityWindowMs: 2700000, bluetoothPollMs: 300000, reminderMs: 1800000,
      deliveryTimeoutMs: 10000 },
  };
  f.monitor = () => createNotificationMonitor({
    store: f.store, clock: () => f.now, getConfig: async () => f.config,
    collectCluster: async () => { f.calls.push("cluster"); if (f.cluster instanceof Error) throw f.cluster; return f.cluster; },
    collectNetwork: async () => { f.calls.push("network"); if (f.onNetwork) return f.onNetwork(); if (f.network instanceof Error) throw f.network; return { timestamp: f.now / 1000, ...f.network }; },
    scanBluetooth: async () => ({ available: false, devices: [] }), learnDeviceAlias: async () => {},
    deliver: async (config, event) => { f.sent.push(event); if (f.onDelivery) return f.onDelivery(config, event); if (f.deliveryError) throw f.deliveryError; return true; },
    log: async (event, fields) => { (f.logs ||= []).push({ event, ...fields }); },
  });
  return f;
}

for (const { name, need, cluster } of credentialObservations) {
  test(`notification observed credential need: ${name}`, async (t) => {
    const f = await fixture(t);
    f.cluster = cluster;
    await f.monitor()();
    assert.deepEqual(f.sent.map((event) => event.kind), need ? [`${need}.password_needed`] : []);
    assert.equal((await f.store.load()).passwordNeed, need);
  });
}

test("cluster collection failure still permits an independent network baseline", async (t) => {
  const f = await fixture(t);
  f.cluster = new Error("cluster unavailable");
  f.network = { devices: [{ mac: knownMac, ip: "192.0.2.10" }] };
  await f.monitor()();
  assert.deepEqual(f.calls, ["cluster", "network"]);
  const state = await f.store.load();
  assert.equal(state.networkDevices[knownMac].present, true);
  assert.equal(state.clusterInitialized, false);
  assert.equal(state.networkInitialized, true);
  assert.deepEqual(f.sent, []);
});

test("unavailable jobs preserve the baseline while accounting advances", async (t) => {
  const f = await fixture(t);
  const running = { id: "42", user: "researcher", name: "simulation", state: "RUNNING" };
  f.cluster.queries = { jobs: { status: "ok" } };
  f.cluster.jobs = [running];
  await f.monitor()();
  f.now += 30000;
  f.cluster = { reachable: true, user: "researcher", queries: { jobs: { status: "failed" } }, jobs: null,
    accountingAvailable: true, terminalJobs: [{ id: "41", user: "researcher", state: "COMPLETED" }] };
  await f.monitor()();
  assert.equal((await f.store.load()).jobs["42"].state, "RUNNING");
  assert.deepEqual(f.sent.map((event) => event.kind), ["job.completed"]);
  f.cluster = { ...f.cluster, queries: { jobs: { status: "ok" } }, jobs: [running] };
  await f.monitor()();
  assert.deepEqual(f.sent.map((event) => event.kind), ["job.completed"]);
  f.cluster.jobs = [];
  await f.monitor()();
  assert.deepEqual((await f.store.load()).jobs, {});
  f.cluster.jobs = [running];
  await f.monitor()();
  assert.deepEqual(f.sent.map((event) => event.kind), ["job.completed", "job.running"]);
});

test("legacy and malformed jobs cannot initialize or replace the baseline", async (t) => {
  const f = await fixture(t);
  delete f.cluster.queries;
  await f.monitor()();
  assert.equal((await f.store.load()).clusterInitialized, false);
  const running = { id: "42", user: "researcher", state: "RUNNING" };
  f.cluster.queries = { jobs: { status: "ok" } };
  f.cluster.jobs = [running];
  await f.monitor()();
  assert.deepEqual(f.sent, []);
  for (const invalid of [null, {}, [{ ...running, id: "" }],
    [running, { ...running, state: "PENDING" }]]) {
    f.cluster.jobs = invalid;
    await f.monitor()();
    assert.equal((await f.store.load()).jobs["42"].state, "RUNNING");
  }
  delete f.cluster.queries;
  f.cluster.jobs = [];
  await f.monitor()();
  assert.equal((await f.store.load()).jobs["42"].state, "RUNNING");
  assert.deepEqual(f.sent, []);
});

test("confirmed remote response ends password reminders despite failed scheduler queries", async (t) => {
  const f = await fixture(t);
  f.cluster = { reachable: false, health: { checks: [{ key: "ticket", ok: false, state: "needs password" }] } };
  f.deliveryError = new Error("offline");
  await f.monitor()();
  assert.equal((await f.store.load()).pending.length, 1);
  f.cluster = { reachable: false, health: { checks: [
    { key: "vpn", ok: false, state: "unknown" }, { key: "ticket", ok: false, state: "unknown" },
  ] } };
  await f.monitor()();
  assert.equal((await f.store.load()).pending.length, 1);
  f.cluster = { reachable: true, user: "researcher", queries: { jobs: { status: "failed" } }, jobs: null };
  await f.monitor()();
  assert.equal((await f.store.load()).passwordNeed, null);
  assert.deepEqual((await f.store.load()).pending, []);
});

test("failed cluster job alert survives disappearing job and coordinator restart", async (t) => {
  const f = await fixture(t);
  await f.monitor()();
  f.now += 30000;
  f.cluster.jobs = [{ id: "42", user: "researcher", name: "simulation", state: "RUNNING", submittedAt: "2026-10-11T12:00:00" }];
  f.deliveryError = new Error("offline");
  await f.monitor()();
  let saved = await f.store.load();
  assert.equal(saved.pending.length, 1);
  assert.equal(saved.pending[0].kind, "job.running");
  assert.equal(saved.networkCheckedAt, f.now);
  const id = saved.pending[0].sequenceId;
  f.now += 30000;
  f.cluster.jobs = [];
  f.deliveryError = null;
  await f.monitor()();
  saved = await f.store.load();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].sequenceId, id);
  assert.equal(f.sent[1].message, "simulation (42) is now running.");
  assert.deepEqual(saved.pending, []);
  assert.deepEqual(saved.jobs, {});
});

test("password reminder survives unknown health, cancels on recovery, and follows success cadence", async (t) => {
  const f = await fixture(t);
  f.cluster = { reachable: false, health: { checks: [{ key: "vpn", ok: false, state: "needs password" }] } };
  f.deliveryError = new Error("offline");
  await f.monitor()();
  const pending = (await f.store.load()).pending[0];
  assert.equal(pending.kind, "vpn.password_needed");
  f.cluster = { reachable: false, health: { checks: [{ key: "slurm", ok: false, state: "blocked" }] } };
  f.now += 30000;
  await f.monitor()();
  assert.equal((await f.store.load()).pending[0].sequenceId, pending.sequenceId);
  f.cluster = { reachable: true, user: "researcher", queries: { jobs: { status: "ok" } }, jobs: [] };
  f.now += 30000;
  await f.monitor()();
  assert.deepEqual((await f.store.load()).pending, []);
  assert.equal(f.sent.length, 2);
  f.cluster = { reachable: false, health: { checks: [{ key: "ticket", ok: false, state: "needs password" }] } };
  f.deliveryError = null;
  f.now += 30000;
  await f.monitor()();
  const acceptedAt = f.now;
  const sequence = f.sent.at(-1).sequenceId;
  assert.equal(f.sent.at(-1).kind, "cluster.password_needed");
  assert.equal((await f.store.load()).passwordNotifiedAt, acceptedAt);
  f.now += f.config.reminderMs - 1;
  await f.monitor()();
  assert.equal(f.sent.length, 3);
  f.now += 1;
  await f.monitor()();
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent.at(-1).sequenceId, sequence);
});

test("first-seen alert and hourly summary retain content and identity across retries", async (t) => {
  const f = await fixture(t);
  f.network.devices = [{ mac: knownMac, ip: "192.0.2.10" }];
  await f.monitor()();
  const state = await f.store.load();
  state.networkEvents.push({ type: "away", timestamp: f.now + 1000, mac: knownMac, label: "fixture", lastSeen: f.now - 120000 });
  await f.store.save(state);
  f.network.devices.push({ mac: visitorMac, ip: "192.0.2.20", nickname: "visitor" });
  f.now += 30000;
  await f.monitor()();
  f.now += 30000;
  f.deliveryError = new Error("offline");
  await f.monitor()();
  let pending = (await f.store.load()).pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "network.first_seen");
  f.now = Date.UTC(2026, 9, 11, 13);
  await f.monitor()();
  pending = (await f.store.load()).pending;
  assert.deepEqual(pending.map((event) => event.kind).sort(), ["network.first_seen", "network.hourly_summary"]);
  const summary = pending.find((event) => event.kind === "network.hourly_summary");
  assert.match(summary.message, /2026-10-11T12:00:00.000Z/);
  assert.equal((await f.store.load()).networkSummarySentHour, 0);
  const attemptsBeforeRecovery = f.sent.length;
  f.now = Date.UTC(2026, 9, 12, 13);
  f.network.devices = [];
  f.deliveryError = null;
  await f.monitor()();
  assert.ok(f.sent.slice(attemptsBeforeRecovery).some((event) => event.kind === "network.first_seen" && event.message.includes("visitor")));
  assert.ok(f.sent.slice(attemptsBeforeRecovery).some((event) => event.sequenceId === summary.sequenceId && event.message === summary.message));
  assert.deepEqual((await f.store.load()).pending, []);
});

test("bounded delivery alternates domains across restarts rather than starving network alerts", async (t) => {
  const f = await fixture(t);
  f.network.devices = [{ mac: knownMac }];
  await f.monitor()();
  f.network.devices.push({ mac: visitorMac });
  f.now += 30000;
  await f.monitor()();
  f.now += 30000;
  f.cluster.jobs = [1, 2, 3].map((id) => ({ id: String(id), user: "researcher", state: "RUNNING" }));
  f.onDelivery = async (config) => {
    assert.ok(config.deliveryTimeoutMs <= 10000);
    f.now += config.deliveryTimeoutMs;
    throw new Error("timeout");
  };
  await f.monitor()();
  assert.deepEqual(f.sent.map((event) => event.domain), ["cluster", "network"]);
  assert.equal((await f.store.load()).pending.length, 4);
  f.sent = [];
  await f.monitor()();
  assert.deepEqual(f.sent.map((event) => event.domain), ["cluster", "network"]);
  assert.equal(f.sent[0].message, "job (2) is now running.");
});

test("failed acknowledgement replays the same accepted identity after reloading the saved checkpoint", async (t) => {
  const f = await fixture(t);
  await f.monitor()();
  const realStore = f.store;
  let accepted = false;
  f.store = {
    load: realStore.load,
    save: async (state) => { if (accepted) throw new Error("disk unavailable"); await realStore.save(state); },
  };
  f.cluster.jobs = [{ id: "42", user: "researcher", state: "RUNNING" }];
  f.now += 30000;
  f.onDelivery = async () => { accepted = true; return true; };
  await f.monitor()();
  const saved = await realStore.load();
  assert.equal(saved.pending.length, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.logs.at(-1).error, /disk unavailable/);
  f.store = realStore;
  f.now += 30000;
  await f.monitor()();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].sequenceId, f.sent[0].sequenceId);
  assert.deepEqual((await realStore.load()).pending, []);
});

test("failed observation checkpoint stops all delivery and is reloaded without leaking its draft", async (t) => {
  const f = await fixture(t);
  await f.monitor()();
  const saved = await f.store.load();
  const realStore = f.store;
  f.store = { load: realStore.load, save: async () => { throw new Error("disk full"); } };
  f.cluster.jobs = [{ id: "42", user: "researcher", state: "RUNNING" }];
  f.now += 30000;
  await f.monitor()();
  assert.deepEqual(await realStore.load(), saved);
  assert.deepEqual(f.sent, []);
  f.store = realStore;
  await f.monitor()();
  assert.equal(f.sent.length, 1);
});

test("network collection failure preserves committed cluster progress and retries only new terminal jobs", async (t) => {
  const f = await fixture(t);
  await f.monitor()();
  f.network = new Error("network unavailable");
  f.cluster.terminalJobs = [
    { id: "42", user: "researcher", state: "COMPLETED", submittedAt: "t1", name: "own" },
    { id: "43", user: "other", state: "FAILED", submittedAt: "t2" },
  ];
  f.now += 30000;
  f.deliveryError = new Error("offline");
  await f.monitor()();
  const saved = await f.store.load();
  assert.deepEqual(saved.knownTerminalJobs, { "42:t1": f.now });
  assert.equal(saved.pending.length, 1);
  assert.equal(saved.networkCheckedAt, f.now - 30000);
  f.cluster.terminalJobs = [];
  f.now += 8 * 86400000;
  f.deliveryError = null;
  await f.monitor()();
  assert.deepEqual((await f.store.load()).pending, []);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].sequenceId, f.sent[1].sequenceId);
});

test("overlapping monitor passes are excluded while the same runner recovers afterward", async (t) => {
  const f = await fixture(t);
  let release;
  const original = f.store.load;
  f.store.load = () => new Promise((resolve) => { release = async () => resolve(await original()); });
  const run = f.monitor();
  const first = run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await run(), false);
  await release();
  assert.equal(await first, true);
  assert.deepEqual(f.calls, ["cluster", "network"]);
  f.store.load = original;
  assert.equal(await run(), true);
});

test("disabled notifications retain pending records and use current routing when re-enabled", async (t) => {
  const f = await fixture(t);
  await f.monitor()();
  f.cluster.jobs = [{ id: "42", user: "researcher", state: "RUNNING" }];
  f.now += 30000;
  f.deliveryError = new Error("offline");
  await f.monitor()();
  const saved = await f.store.load();
  f.config.enabled = false;
  const calls = f.calls.length;
  await f.monitor()();
  assert.deepEqual(await f.store.load(), saved);
  assert.equal(f.calls.length, calls);
  f.config.enabled = true;
  f.config.topic = "new-topic";
  f.config.token = "fixture-new-token";
  f.onDelivery = async (config, event) => {
    assert.equal(config.topic, "new-topic");
    assert.equal(config.token, "fixture-new-token");
    assert.equal(event.sequenceId, saved.pending[0].sequenceId);
    return true;
  };
  f.now += 30000;
  await f.monitor()();
  assert.deepEqual((await f.store.load()).pending, []);
  assert.ok(!JSON.stringify(await f.store.load()).includes("fixture-new-token"));
});

test("malformed observations cannot erase good baselines or leak partial changes", async (t) => {
  const f = await fixture(t);
  f.cluster.jobs = [{ id: "42", user: "researcher", state: "RUNNING" }];
  f.network.devices = [{ mac: knownMac }];
  await f.monitor()();
  const before = await f.store.load();
  f.now += 30000;
  f.network = { devices: "broken" };
  f.cluster = { reachable: true };
  await f.monitor()();
  const after = await f.store.load();
  assert.deepEqual(after, before);
  assert.equal(f.logs.filter((item) => item.event.endsWith("_monitor_error")).length, 2);
});

test("corrupt shared state prevents all collection and delivery without overwriting evidence", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, '{"pending": [broken');
  await f.monitor()();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.sent, []);
  assert.equal(await readFile(f.path, "utf8"), '{"pending": [broken');
  assert.ok(f.logs.some((entry) => entry.event === "notify.monitor_error"));
});

test("one failed alert does not block later alerts in the same domain", async (t) => {
  const f = await fixture(t);
  await f.monitor()();
  f.cluster.jobs = [1, 2].map((id) => ({ id: String(id), user: "researcher", state: "RUNNING" }));
  f.now += 30000;
  f.onDelivery = async (config, event) => {
    if (event.message.includes("(1)")) throw new Error("rejected");
    return true;
  };
  await f.monitor()();
  assert.equal(f.sent.length, 2);
  const pending = (await f.store.load()).pending;
  assert.equal(pending.length, 1);
  assert.match(pending[0].message, /\(1\)/);
});

test("a credential change supersedes the old password reminder without replaying it", async (t) => {
  const f = await fixture(t);
  f.cluster = { reachable: false, health: { checks: [{ key: "vpn", ok: false, state: "needs password" }] } };
  f.deliveryError = new Error("offline");
  await f.monitor()();
  const previousId = f.sent[0].sequenceId;
  f.cluster.health.checks = [{ key: "vpn", ok: true }, { key: "ticket", ok: false, state: "needs password" }];
  f.now += 30000;
  f.deliveryError = null;
  await f.monitor()();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].kind, "cluster.password_needed");
  assert.notEqual(f.sent[1].sequenceId, previousId);
  assert.deepEqual((await f.store.load()).pending, []);
});

test("repeated presence snapshots do not confirm arrivals but still allow pending delivery retries", async (t) => {
  const f = await fixture(t);
  f.network.devices = [{ mac: knownMac }];
  await f.monitor()();
  f.now += 30000;
  f.network = { timestamp: f.now / 1000, devices: [{ mac: knownMac }, { mac: visitorMac }] };
  await f.monitor()();
  f.now += 30000;
  await f.monitor()();
  assert.deepEqual(f.sent, []);
  f.now += 30000;
  f.network.timestamp = f.now / 1000;
  f.deliveryError = new Error("offline");
  await f.monitor()();
  const saved = await f.store.load();
  assert.equal(saved.pending.length, 1);
  f.now += 30000;
  f.deliveryError = null;
  await f.monitor()();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].sequenceId, f.sent[1].sequenceId);
  assert.equal((await f.store.load()).networkObservedAt, saved.networkObservedAt);
  assert.deepEqual((await f.store.load()).pending, []);
});

test("presence uses the completion time of a slow network collection", async (t) => {
  const f = await fixture(t);
  f.onNetwork = () => {
    f.now += 2000;
    return { timestamp: f.now / 1000, devices: [{ mac: knownMac }] };
  };
  await f.monitor()();
  const state = await f.store.load();
  assert.equal(state.networkObservedAt, f.now);
  assert.equal(state.networkDevices[knownMac].lastSeen, f.now);
});
