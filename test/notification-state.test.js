import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationStateStore } from "../lib/notification-state.js";

const fixtureMac = (last) => [0, 17, 34, 51, 68, last].map((part) => part.toString(16).padStart(2, "0")).join(":");
const knownMac = fixtureMac(85);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hearth-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");
  return { root, path, store: createNotificationStateStore(path) };
}

test("state migration preserves independent legacy baselines and rejects corrupt data without replacement", async (t) => {
  const f = await fixture(t);
  const legacy = { initialized: true, jobNotificationVersion: 3, networkTrackingVersion: 4,
    jobs: { "42": { id: "42", state: "RUNNING" } }, knownTerminalJobs: { "41:submitted": 123 },
    networkDevices: { [knownMac]: { lastSeen: 123, present: true } },
    networkSummarySentHour: 3600000, passwordNeed: "vpn", passwordEpisodeId: "vpn:123", passwordNotifiedAt: 456 };
  await writeFile(f.path, JSON.stringify(legacy));
  const migrated = await f.store.load();
  assert.equal(migrated.clusterInitialized, true);
  assert.equal(migrated.terminalInitialized, true);
  assert.equal(migrated.networkInitialized, true);
  assert.equal(migrated.networkSummaryGeneratedHour, 3600000);
  assert.deepEqual(migrated.jobs, legacy.jobs);
  assert.deepEqual(migrated.knownTerminalJobs, legacy.knownTerminalJobs);
  assert.equal(migrated.passwordEpisodeId, "vpn:123");
  for (const bad of ["{broken", "[]", "null", "{}", '{"garbage":true}', '{"initialized":true,"jobs":{}}', '{"jobs":[]}', '{"networkDevices":{"mac":null}}',
    '{"networkEvents":[{}]}', '{"pending":[{}]}', '{"version":999}', '{"version":1}', '{"networkTrackingVersion":99}']) {
    await writeFile(f.path, bad);
    await assert.rejects(f.store.load());
    assert.equal(await readFile(f.path, "utf8"), bad);
  }
  await mkdir(join(f.root, "directory"));
  await assert.rejects(createNotificationStateStore(join(f.root, "directory")).load());
});

test("atomic state replacement cleans a failed write and preserves the previous checkpoint", async (t) => {
  const f = await fixture(t);
  const state = await f.store.load();
  assert.deepEqual(await readdir(f.root), []);
  await f.store.save(state);
  const prior = await readFile(f.path, "utf8");
  const fs = await import("node:fs/promises");
  const failed = createNotificationStateStore(f.path, { fs: { ...fs,
    rename: async () => { throw new Error("simulated failed rename"); },
  } });
  await assert.rejects(failed.save({ ...state, initialized: true }), /failed rename/);
  assert.equal(await readFile(f.path, "utf8"), prior);
  assert.deepEqual(await readdir(f.root), ["state.json"]);
});

test("an unreadable state file is not treated as a missing file", async (t) => {
  const f = await fixture(t);
  const denied = createNotificationStateStore(f.path, { fs: {
    readFile: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
  } });
  await assert.rejects(denied.load(), /permission denied/);
  assert.deepEqual(await readdir(f.root), []);
});

test("uncertain directory synchronization fails the save while leaving a reloadable atomic checkpoint", async (t) => {
  const f = await fixture(t);
  const state = await f.store.load();
  await f.store.save(state);
  const fs = await import("node:fs/promises");
  const failing = createNotificationStateStore(f.path, { fs: { ...fs,
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (path !== f.root) return handle;
      return { sync: async () => { throw new Error("directory sync failed"); }, close: () => handle.close() };
    },
  } });
  await assert.rejects(failing.save({ ...state, initialized: true }), /directory sync failed/);
  assert.equal((await f.store.load()).initialized, true);
  assert.deepEqual(await readdir(f.root), ["state.json"]);
});
