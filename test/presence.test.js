import test from "node:test";
import assert from "node:assert/strict";
import { advancePresence, completePresence, projectPresence } from "../lib/presence.js";

const start = 1_800_000_000_000;
const policy = {
  networkPollMs: 30_000,
  networkJoinScans: 2,
  networkOnlineGraceMs: 600_000,
  networkAwayMs: 2_700_000,
  networkIdentityWindowMs: 2_700_000,
  networkUnknownRetentionMs: 604_800_000,
  bluetoothPollMs: 300_000,
};
const mac = (suffix) => ["02", "00", "00", "00", "00", suffix].join(":");
const device = (suffix, extra = {}) => ({ mac: mac(suffix), ip: `192.0.2.${parseInt(suffix, 16)}`, ...extra });
const snapshot = (time, devices) => ({ timestamp: time / 1000, source: "nmap", devices });
const advance = (state, time, devices) => advancePresence({ state, network: snapshot(time, devices), config: policy, nowMs: time });

test("the initial presence baseline is quiet and projects a continuous session", () => {
  const input = { initialized: true, jobs: { unrelated: { state: "RUNNING" } } };
  const before = structuredClone(input);
  const result = advance(input, start, [device("01")]);
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.state.networkEvents, []);
  assert.deepEqual(input, before, "the model must not mutate caller-owned state");
  assert.deepEqual(result.state.jobs, before.jobs);
  const next = advance(result.state, start + 30_000, [device("01")]);
  const view = projectPresence({ state: next.state, network: snapshot(start + 30_000, [device("01")]), config: policy, nowMs: start + 30_000 });
  assert.equal(view.devices[0].onlineSince, 1_800_000_000);
  assert.equal(view.devices[0].lastSeen, 1_800_000_030);
  assert.deepEqual(view.counts, { online: 1, offline: 0 });
});

test("arrival confirmation needs consecutive observations and stays distinct from dashboard status", () => {
  let state = advance({}, start, [device("01")]).state;
  state = advance(state, start + 30_000, [device("01"), device("02")]).state;
  assert.equal(state.networkDevices[mac("02")].pendingJoin, true);
  let result = advance(state, start + 60_000, [device("01")]);
  assert.deepEqual(result.alerts, []);
  result = advance(result.state, start + 90_000, [device("01"), device("02")]);
  assert.deepEqual(result.alerts, [], "a miss breaks confirmation");
  const view = projectPresence({ state: result.state, network: snapshot(start + 90_000, [device("01"), device("02")]), config: policy, nowMs: start + 90_000 });
  assert.equal(view.devices.find((d) => d.mac === mac("02")).status, "online");
  result = advance(result.state, start + 120_000, [device("01"), device("02")]);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.state.networkDevices[mac("02")].pendingJoin, false);
  assert.deepEqual(result.state.networkEvents.map((e) => e.type), ["first_seen"]);
  assert.deepEqual(advance(result.state, start + 150_000, [device("01"), device("02")]).alerts, []);
});

test("offline precedes away and a confirmed return keeps the first observation and full absence", () => {
  let state = advance({}, start, [device("01")]).state;
  state = advance(state, start + 599_000, []).state;
  let view = projectPresence({ state, network: snapshot(start + 599_000, []), config: policy, nowMs: start + 599_999 });
  assert.equal(view.devices[0].status, "online");
  view = projectPresence({ state, network: snapshot(start + 599_000, []), config: policy, nowMs: start + 600_000 });
  assert.equal(view.devices[0].status, "offline");
  assert.equal(view.devices[0].away, false);
  assert.equal(state.networkDevices[mac("01")].present, true);
  state = advance(state, start + 2_699_000, []).state;
  assert.equal(state.networkDevices[mac("01")].present, true);
  let result = advance(state, start + 2_700_000, []);
  assert.equal(result.state.networkDevices[mac("01")].present, false);
  assert.equal(result.departures.length, 1);
  state = result.state;
  result = advance(state, start + 3_000_000, [device("01")]);
  assert.equal(result.state.networkDevices[mac("01")].pendingJoin, true);
  const returnedView = projectPresence({ state, network: snapshot(start + 3_000_000, [device("01")]), config: policy, nowMs: start + 3_000_000 });
  assert.equal(returnedView.devices[0].onlineSince, 1_800_003_000);
  result = advance(result.state, start + 3_030_000, [device("01")]);
  assert.deepEqual(result.alerts, []);
  const event = result.state.networkEvents.find((e) => e.type === "returned");
  assert.equal(event.awayDurationMs, 3_000_000);
  assert.equal(result.state.networkDevices[mac("01")].onlineSince, start + 3_000_000);
});

test("cached, older and failed scans supply no new confirmation evidence", () => {
  let state = advance({}, start, [device("01")]).state;
  state = advance(state, start + 30_000, [device("01"), device("02")]).state;
  for (const network of [snapshot(start + 30_000, [device("01"), device("02")]), snapshot(start, []), null]) {
    const result = advancePresence({ state, network, config: policy, nowMs: start + 60_000 });
    assert.deepEqual(result.state, state);
    assert.deepEqual(result.alerts, []);
    assert.deepEqual(result.departures, []);
  }
  const confirmed = advance(state, start + 90_000, [device("01"), device("02")]);
  assert.equal(confirmed.alerts.length, 1, "failed scans do not reset confirmation");
});

test("scan timestamps retain millisecond precision and cached dashboard data ages", () => {
  const network = snapshot(start + 123, [device("01")]);
  const result = advancePresence({ state: {}, network, config: policy, nowMs: start + 60_000 });
  assert.equal(result.state.networkDevices[mac("01")].lastSeen, start + 123);
  const view = projectPresence({ state: result.state, network, config: policy, nowMs: start + 600_123 });
  assert.equal(view.devices[0].status, "offline");
  assert.equal(view.devices[0].lastSeen, 1_800_000_000);
  const older = projectPresence({ state: result.state, network: snapshot(start, [device("01")]), config: policy, nowMs: start + 600_123 });
  assert.equal(older.devices[0].lastSeen, 1_800_000_000);
});

test("legacy state migrates without a new-device alert and retains compatible session estimates", () => {
  for (const version of [2, 3, 4]) {
    const state = {
      initialized: true,
      networkTrackingVersion: version,
      networkDevices: {
        [mac("01")]: { ...device("01"), key: mac("01"), lastSeen: start, seenScans: 4 },
        "192.0.2.90": { ip: "192.0.2.90", lastSeen: start },
      },
      networkEvents: [{ type: "returned", mac: mac("01"), timestamp: start }],
    };
    const result = advance(state, start + 30_000, [device("01")]);
    assert.equal(result.state.networkTrackingVersion, 4);
    assert.deepEqual(Object.keys(result.state.networkDevices), [mac("01")]);
    assert.equal(result.state.networkDevices[mac("01")].onlineSince, version === 4 ? start + 30_000 : start - 90_000);
    assert.equal(result.state.networkEvents.length, version < 3 ? 0 : 1);
    assert.deepEqual(result.alerts, []);
  }
});

test("single-candidate address inference keeps its alias and hides the replaced address", () => {
  let state = advance({}, start, [device("01", { nickname: "Desk" })]).state;
  state = advance(state, start + 30_000, []).state;
  const result = advance(state, start + 60_000, [device("02")]);
  const replacement = result.state.networkDevices[mac("02")];
  assert.equal(replacement.identityKey, mac("01"));
  assert.equal(replacement.nickname, "Desk");
  assert.equal(result.state.networkDevices[mac("01")].replacedBy, mac("02"));
  assert.equal(result.aliasWrites[0].nickname, "Desk");
  assert.deepEqual(result.state.networkEvents.map((e) => e.type), ["address_changed"]);
  assert.deepEqual(result.alerts, []);
  const view = projectPresence({ state: result.state, network: snapshot(start + 60_000, [device("02")]), config: policy, nowMs: start + 60_000 });
  assert.deepEqual(view.devices.map((d) => d.mac), [mac("02")]);
  assert.equal(view.devices[0].nickname, "Desk");
});

test("ambiguous identity keeps candidates separate and preserves the uncertain label", () => {
  let state = advance({}, start, [device("01", { nickname: "Desk" }), device("02", { name: "Tablet" })]).state;
  state = advance(state, start + 30_000, []).state;
  const result = advance(state, start + 60_000, [device("03")]);
  const newcomer = result.state.networkDevices[mac("03")];
  assert.equal(newcomer.nickname, "uncertain: Desk or Tablet");
  assert.equal(newcomer.identityConfidence, "uncertain");
  assert.deepEqual(newcomer.possibleIdentityKeys, [mac("01"), mac("02")]);
  assert.deepEqual(result.aliasWrites, []);
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.state.networkEvents.map((e) => e.type), ["uncertain"]);
  assert.equal(result.state.networkDevices[mac("01")].replacedBy, undefined);
});

test("projection preserves naming, retention, sorting, local uptime and the API shape", () => {
  const state = advance({}, start, [device("01", { nickname: "Desk" }), device("02", { name: "unknown" }), device("03")]).state;
  const now = start + policy.networkUnknownRetentionMs + 1;
  const network = snapshot(now, [device("04"), { ip: "192.0.2.99", name: "Hearth" }]);
  const view = projectPresence({
    state, network, config: policy, nowMs: now, localOnlineSinceMs: now - 100_000,
    names: { [mac("03").toUpperCase()]: "Lamp", "192.0.2.4": "Phone" },
  });
  assert.deepEqual(view.devices.map((d) => d.nickname || d.name), ["Hearth", "Phone", "Desk", "Lamp"]);
  assert.deepEqual(view.counts, { online: 2, offline: 2 });
  assert.equal(view.devices[0].onlineSince, Math.floor((now - 100_000) / 1000));
  assert.deepEqual(Object.keys(view.devices[1]).sort(), ["ip", "lastSeen", "mac", "nickname", "onlineSince", "status"]);
  assert.equal(view.devices[2].away, true);
  assert.equal(view.timestamp, network.timestamp);
  assert.equal(view.source, "nmap");
  assert.equal(state.networkDevices[mac("04")], undefined, "projection is read-only");
});

test("departure events retain Bluetooth context without requiring Bluetooth availability", () => {
  let state = advance({}, start, [device("01")]).state;
  state.bluetoothSnapshot = { available: true, timestamp: start / 1000, devices: [{ address: "synthetic-beacon", name: "Beacon" }] };
  state.bluetoothCheckedAt = start;
  state = advance(state, start + 30_000, []).state;
  const update = advance(state, start + policy.networkAwayMs, []);
  assert.equal(update.bluetoothScanDue, true);
  for (const bluetooth of [undefined, { available: false, devices: [] }, { available: true, timestamp: (start + policy.networkAwayMs) / 1000, devices: [] }]) {
    const completed = completePresence({ update, bluetooth, nowMs: start + policy.networkAwayMs });
    assert.equal(completed.state.networkEvents.length, 1);
    const event = completed.state.networkEvents[0];
    assert.equal(event.type, "away");
    assert.equal(event.bluetooth.confidence, bluetooth?.available ? "possible" : "unavailable");
    assert.equal(completed.state.networkDevices[mac("01")].bluetoothBefore, undefined);
    assert.equal(completed.state.bluetoothCheckedAt, bluetooth ? start + policy.networkAwayMs : start);
  }
  assert.deepEqual(update.state.networkEvents, [], "completion must not mutate its input");
});

test("transient misses preserve a session and pending returns survive a saved-state restart", () => {
  let state = advance({}, start, [device("01")]).state;
  state = advance(state, start + 30_000, []).state;
  state = advance(state, start + 60_000, [device("01")]).state;
  assert.equal(state.networkDevices[mac("01")].onlineSince, start);
  assert.deepEqual(state.networkEvents, []);
  state = advance(state, start + 3_000_000, []).state;
  state = advance(state, start + 3_030_000, [device("01")]).state;
  state = JSON.parse(JSON.stringify(state));
  state = advance(state, start + 3_060_000, []).state;
  state = advance(state, start + 3_090_000, [device("01")]).state;
  assert.equal(state.networkDevices[mac("01")].pendingJoin, true);
  state = advance(state, start + 3_120_000, [device("01")]).state;
  assert.equal(state.networkDevices[mac("01")].onlineSince, start + 3_030_000);
  assert.equal(state.networkEvents.find((e) => e.type === "returned").awayDurationMs, 2_970_000);
});

test("identity matching respects the private-address class, window and one claim per scan", () => {
  let state = advance({}, start, [device("01", { nickname: "Desk" })]).state;
  state = advance(state, start + 30_000, []).state;
  const atBoundary = advance(state, start + 30_000 + policy.networkIdentityWindowMs, [device("02"), device("03")]);
  assert.equal(atBoundary.state.networkDevices[mac("02")].inferredFrom, mac("01"));
  assert.equal(atBoundary.state.networkDevices[mac("03")].pendingJoin, true);
  const expired = advance(state, start + 31_000 + policy.networkIdentityWindowMs, [device("02")]);
  assert.deepEqual(expired.aliasWrites, []);
  assert.equal(expired.state.networkDevices[mac("02")].pendingJoin, true);
  const publicMac = ["00", "00", "00", "00", "00", "02"].join(":");
  const differentClass = advance(state, start + 60_000, [device("02", { mac: publicMac })]);
  assert.deepEqual(differentClass.aliasWrites, []);
  assert.equal(differentClass.state.networkDevices[publicMac].pendingJoin, true);
});

test("unknown history expires only after the configured retention boundary", () => {
  const state = advance({}, start, [device("01")]).state;
  const viewAt = (time) => projectPresence({ state, network: snapshot(time, []), config: policy, nowMs: time });
  assert.equal(viewAt(start + policy.networkUnknownRetentionMs).devices.length, 1);
  assert.equal(viewAt(start + policy.networkUnknownRetentionMs + 1).devices.length, 0);
});

test("an unconfirmed first arrival stays a first arrival after a long absence", () => {
  let state = advance({}, start, [device("01")]).state;
  state = advance(state, start + 30_000, [device("01"), device("02")]).state;
  state = advance(state, start + 3_000_000, [device("01")]).state;
  state = advance(state, start + 3_030_000, [device("01"), device("02")]).state;
  const result = advance(state, start + 3_060_000, [device("01"), device("02")]);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.state.networkEvents.at(-1).type, "first_seen");
});

test("older dashboard snapshots cannot resurrect a replaced address", () => {
  let state = advance({}, start, [device("01", { nickname: "Desk" })]).state;
  state = advance(state, start + 30_000, []).state;
  state = advance(state, start + 60_000, [device("02")]).state;
  const view = projectPresence({ state, network: snapshot(start, [device("01")]), config: policy, nowMs: start + 60_000 });
  assert.deepEqual(view.devices.map((d) => d.mac), [mac("02")]);
  assert.deepEqual(view.counts, { online: 1, offline: 0 });
});

test("older dashboard snapshots cannot replace newer IP and name observations", () => {
  let state = advance({}, start, [device("01", { name: "Old name" })]).state;
  state = advance(state, start + 30_000, [device("01", { ip: "192.0.2.20", name: "New name" })]).state;
  const view = projectPresence({ state, network: snapshot(start, [device("01", { name: "Old name" })]), config: policy, nowMs: start + 30_000 });
  assert.equal(view.devices[0].ip, "192.0.2.20");
  assert.equal(view.devices[0].name, "New name");
  assert.equal(view.devices[0].lastSeen, 1_800_000_030);
});
