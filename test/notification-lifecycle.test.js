import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationConfiguration } from "../lib/notification-config.js";
import { createNotificationLoop, createNotificationMonitor } from "../lib/notification-monitor.js";
import { createNotificationStateStore } from "../lib/notification-state.js";

test("a failed notification run and failed reload report both errors in occurrence order", async () => {
  const runError = new Error("run failed");
  const reloadError = new Error("reload failed");
  const timers = [];
  const loop = createNotificationLoop({
    run: async () => { throw runError; },
    getConfig: async () => { throw reloadError; },
    schedule: (...args) => timers.push(args),
  });
  await assert.rejects(loop(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [runError, reloadError]);
    assert.equal(error.cause, runError);
    return true;
  });
  assert.deepEqual(timers, []);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hearth-notification-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const configPath = join(root, "notifications.json");
  const statePath = join(root, "state.json");
  const configuration = createNotificationConfiguration(configPath, (event, fields) => events.push({ event, ...fields }));
  const f = {
    configPath, statePath, configuration, events, collections: [], deliveries: [], timers: [],
    store: createNotificationStateStore(statePath),
    write: (value) => writeFile(configPath, JSON.stringify(value)),
    enabled: { enabled: true, endpoint: "https://notify.invalid/base", topic: "fixture", pollMs: 1000 },
  };
  f.run = createNotificationMonitor({
    store: f.store, getConfig: configuration.getConfig,
    collectCluster: async () => {
      f.collections.push("cluster");
      if (f.duringCollection) await f.duringCollection();
      return { reachable: true, user: "fixture", queries: { jobs: { status: "ok" } }, jobs: [] };
    },
    collectNetwork: async () => { f.collections.push("network"); return { devices: [], timestamp: Date.now() / 1000 }; },
    scanBluetooth: async () => ({ available: false, devices: [] }), learnDeviceAlias: async () => {},
    deliver: async (config, event) => { f.deliveries.push({ config, event }); if (f.duringDelivery) await f.duringDelivery(); return true; },
    log: (event, fields) => events.push({ event, ...fields }),
  });
  f.loop = createNotificationLoop({ run: f.run, getConfig: configuration.getConfig,
    schedule: (callback, delay) => f.timers.push({ callback, delay }) });
  return f;
}

test("startup disabled or invalid recovers without restarting and without collecting while paused", async (t) => {
  const f = await fixture(t);
  await f.loop();
  assert.equal(f.timers[0].delay, 30000);
  await assert.rejects(readFile(f.statePath), { code: "ENOENT" });
  await writeFile(f.configPath, '{"token":"secret",');
  await f.timers.shift().callback();
  assert.equal(f.timers[0].delay, 30000);
  assert.deepEqual(f.collections, []);
  assert.deepEqual(f.events.map((item) => item.event), ["notify.config_error"]);
  await f.write(f.enabled);
  await f.timers.shift().callback();
  assert.equal(f.timers[0].delay, 1000);
  assert.deepEqual(f.collections, ["cluster", "network"]);
  const before = await readFile(f.statePath, "utf8");
  await f.write({ enabled: false, pollMs: -1 });
  await f.timers.shift().callback();
  assert.equal(f.timers[0].delay, 30000);
  assert.equal(await readFile(f.statePath, "utf8"), before);
  await f.timers.shift().callback();
  assert.equal(f.events.filter((item) => item.event === "notify.config_error").length, 2);
  assert.equal(f.events.some((item) => item.event === "notify.monitor_error"), false);
});

test("an invalid edit during collection checkpoints observations and preserves queued delivery through correction", async (t) => {
  const f = await fixture(t);
  const state = await f.store.load();
  const pending = { kind: "network.first_seen", domain: "network", sequenceId: "hearth-original",
    title: "New device", message: "Original message", createdAt: 1, lastAttemptAt: null };
  state.pending.push(pending);
  await f.store.save(state);
  await f.write(f.enabled);
  f.duringCollection = () => writeFile(f.configPath, "{invalid");
  await f.loop();
  assert.deepEqual(f.collections, ["cluster", "network"]);
  assert.equal((await f.store.load()).networkInitialized, true);
  assert.deepEqual((await f.store.load()).pending, [pending]);
  assert.deepEqual(f.deliveries, []);
  assert.equal(f.timers[0].delay, 30000);
  f.duringCollection = null;
  await f.write({ ...f.enabled, endpoint: "https://corrected.invalid/base", token: "new-token" });
  await f.timers.shift().callback();
  assert.equal(f.deliveries[0].event.sequenceId, "hearth-original");
  assert.equal(f.deliveries[0].event.message, "Original message");
  assert.equal(f.deliveries[0].config.endpoint, "https://corrected.invalid/base");
  assert.equal(f.deliveries[0].config.token, "new-token");
  assert.deepEqual((await f.store.load()).pending, []);
  assert.doesNotMatch(await readFile(f.statePath, "utf8"), /new-token/);
});

test("a request already underway is checkpointed while an invalid edit stops later sends", async (t) => {
  const f = await fixture(t);
  const state = await f.store.load();
  state.pending = ["first", "second"].map((id) => ({ kind: "network.first_seen", domain: "network",
    sequenceId: id, title: id, message: id, createdAt: 1, lastAttemptAt: null }));
  await f.store.save(state);
  await f.write(f.enabled);
  f.duringDelivery = () => writeFile(f.configPath, "null");
  await f.loop();
  assert.deepEqual(f.deliveries.map(({ event }) => event.sequenceId), ["first"]);
  assert.deepEqual((await f.store.load()).pending.map((event) => event.sequenceId), ["second"]);
  assert.equal(f.timers[0].delay, 30000);
});
