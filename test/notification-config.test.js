import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNotificationConfiguration, readNotificationConfig } from "../lib/notification-config.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hearth-notification-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "notifications.json");
  return { path, write: (value) => writeFile(path, JSON.stringify(value)) };
}

test("missing notification configuration is disabled with the documented defaults", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await readNotificationConfig(f.path), {
    enabled: false, endpoint: "", topic: "", dashboardUrl: "", networkUrl: "", token: "", cache: true,
    pollMs: 30000, deliveryTimeoutMs: 10000, networkPollMs: 30000, networkJoinScans: 2,
    networkOnlineGraceMs: 600000, networkAwayMs: 2700000, networkIdentityWindowMs: 2700000,
    networkUnknownRetentionMs: 604800000, bluetoothPollMs: 300000, bluetoothScanSeconds: 8, reminderMs: 1800000,
  });
});

test("invalid files and roots report configuration errors without echoing their contents", async (t) => {
  const f = await fixture(t);
  for (const raw of ['{"token":"do-not-print",', "", "null", "[]", "false", '"do-not-print"', "{}"] ) {
    await writeFile(f.path, raw);
    await assert.rejects(readNotificationConfig(f.path), (error) => {
      assert.equal(error.name, "NotificationConfigError");
      assert.doesNotMatch(error.message, /do-not-print/);
      return true;
    });
  }
  await rm(f.path);
  await mkdir(f.path);
  await assert.rejects(readNotificationConfig(f.path), /could not be read/);
  await rm(f.path, { recursive: true });
  await f.write({ enabled: false });
  assert.equal((await readNotificationConfig(f.path)).enabled, false);
});

test("numeric settings accept only the agreed integer ranges, even while disabled", async (t) => {
  const f = await fixture(t);
  for (const [field, minimum, maximum] of [
    ["pollMs", 1000, 2147483647], ["deliveryTimeoutMs", 1000, Number.MAX_SAFE_INTEGER],
    ["networkPollMs", 1, Number.MAX_SAFE_INTEGER], ["networkJoinScans", 1, Number.MAX_SAFE_INTEGER],
    ["networkOnlineGraceMs", 1, Number.MAX_SAFE_INTEGER], ["networkAwayMs", 1, Number.MAX_SAFE_INTEGER],
    ["networkIdentityWindowMs", 1, Number.MAX_SAFE_INTEGER], ["networkUnknownRetentionMs", 1, Number.MAX_SAFE_INTEGER],
    ["bluetoothPollMs", 1, Number.MAX_SAFE_INTEGER], ["bluetoothScanSeconds", 3, 20],
    ["reminderMs", 1, Number.MAX_SAFE_INTEGER],
  ]) {
    const input = { enabled: false, networkOnlineGraceMs: 1, networkAwayMs: 1,
      networkUnknownRetentionMs: Number.MAX_SAFE_INTEGER };
    if (field === "networkOnlineGraceMs") input.networkAwayMs = Number.MAX_SAFE_INTEGER;
    for (const value of [minimum, maximum]) {
      await f.write({ ...input, [field]: value });
      assert.equal((await readNotificationConfig(f.path))[field], value, field);
    }
    for (const value of [0, -1, minimum - 1, maximum + 1, 1.5, String(minimum), true, null, [], [minimum], "Infinity"]) {
      await f.write({ ...input, [field]: value });
      await assert.rejects(readNotificationConfig(f.path), (error) => error.field === field, `${field}: ${JSON.stringify(value)}`);
    }
  }
});

test("presence thresholds preserve online, away, and retention ordering", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { networkOnlineGraceMs: 2700001 }, { networkUnknownRetentionMs: 2699999 },
  ]) {
    await f.write({ enabled: false, ...input });
    await assert.rejects(readNotificationConfig(f.path), /must not exceed/);
  }
  await f.write({ enabled: false, networkOnlineGraceMs: 1, networkAwayMs: 1, networkUnknownRetentionMs: 1 });
  assert.equal((await readNotificationConfig(f.path)).networkAwayMs, 1);
});

test("enabled destinations are explicit and supplied strings remain valid while disabled", async (t) => {
  const f = await fixture(t);
  const enabled = { enabled: true, endpoint: "https://notify.example.invalid/base", topic: " private/主题 " };
  await f.write(enabled);
  const valid = await readNotificationConfig(f.path);
  assert.equal(valid.endpoint, enabled.endpoint);
  assert.equal(valid.topic, enabled.topic);
  for (const input of [{ enabled: true }, { ...enabled, endpoint: undefined }, { ...enabled, topic: undefined },
    { enabled: "true" }, { enabled: false, cache: 0 }, { enabled: false, unexpected: "secret" }]) {
    await f.write(input);
    await assert.rejects(readNotificationConfig(f.path), /Notification configuration/);
  }
  for (const endpoint of [null, 1, "", "http://", "ftp://notify.invalid", "https://a:b@notify.invalid",
    "https://notify.invalid/?x=y", "https://notify.invalid/?", "https://notify.invalid/#", "https://notify.invalid/#x"]) {
    await f.write({ ...enabled, enabled: false, endpoint });
    await assert.rejects(readNotificationConfig(f.path), (error) => error.field === "endpoint");
  }
  for (const topic of [null, false, "", " \t", ".", "..", "\ud800"]) {
    await f.write({ ...enabled, enabled: false, topic });
    await assert.rejects(readNotificationConfig(f.path), (error) => error.field === "topic");
  }
  for (const field of ["dashboardUrl", "networkUrl"]) {
    for (const value of [false, null, "ftp://invalid", "https://a:b@invalid", "\r\nhttps://invalid"]) {
      await f.write({ ...enabled, [field]: value });
      await assert.rejects(readNotificationConfig(f.path), (error) => error.field === field);
    }
    await f.write({ ...enabled, [field]: "https://hearth.invalid/路径?q=主题#network" });
    assert.equal((await readNotificationConfig(f.path))[field], "https://hearth.invalid/%E8%B7%AF%E5%BE%84?q=%E4%B8%BB%E9%A2%98#network");
  }
  await f.write({ ...enabled, endpoint: "https://notify.invalid/base path" });
  assert.equal((await readNotificationConfig(f.path)).endpoint, "https://notify.invalid/base%20path");
  for (const token of [false, null, "secret\r\nheader", "secret\0", "主题"]) {
    await f.write({ ...enabled, token });
    await assert.rejects(readNotificationConfig(f.path), (error) => {
      assert.doesNotMatch(error.message, /secret|主题/);
      return error.field === "token";
    });
  }
  await f.write({ ...enabled, cache: false, token: "test-token" });
  assert.equal((await readNotificationConfig(f.path)).cache, false);
});

test("runtime errors retain only the last valid presence policy and report transitions once", async (t) => {
  const f = await fixture(t);
  const events = [];
  const config = createNotificationConfiguration(f.path, (event, fields) => events.push({ event, ...fields }));
  await writeFile(f.path, '{"token":"secret",');
  assert.equal((await config.getPresencePolicy()).networkOnlineGraceMs, 600000);
  await assert.rejects(config.getConfig(), /valid JSON/);
  assert.equal(events.length, 1);
  await f.write({ enabled: false, networkOnlineGraceMs: 1000 });
  assert.equal((await config.getConfig()).enabled, false);
  await writeFile(f.path, '{"token":"secret",');
  assert.equal((await config.getPresencePolicy()).networkOnlineGraceMs, 1000);
  const policy = await config.getPresencePolicy();
  assert.equal(Object.hasOwn(policy, "token"), false);
  assert.equal(Object.hasOwn(policy, "enabled"), false);
  await f.write({ enabled: false, pollMs: -1 });
  await assert.rejects(config.getConfig(), /pollMs/);
  await rm(f.path);
  assert.equal((await config.getPresencePolicy()).networkOnlineGraceMs, 600000);
  assert.deepEqual(events.map((item) => item.event), [
    "notify.config_error", "notify.config_recovered", "notify.config_error", "notify.config_error", "notify.config_recovered",
  ]);
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});
