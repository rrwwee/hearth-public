import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceLabels, createFileDeviceLabelStorage, createMemoryDeviceLabelStorage } from "../lib/device-labels.js";

test("overlapping manual and inferred labels preserve both updates and unrelated configuration", async () => {
  const storage = createMemoryDeviceLabelStorage(JSON.stringify({
    devices: { existing: "Existing" }, extra: { keep: true },
  }));
  let release;
  let captured;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstRead = new Promise((resolve) => { captured = resolve; });
  let hold = true;
  const labels = createDeviceLabels({
    ...storage,
    async read() {
      const snapshot = await storage.read();
      if (hold) {
        hold = false;
        captured();
        await gate;
      }
      return snapshot;
    },
  });
  const manual = labels.setManual(["manual"], "Manual");
  await firstRead;
  const learned = labels.learnAlias("learned", "Learned");
  release();
  await Promise.all([manual, learned]);
  assert.deepEqual(await labels.read(), {
    devices: { existing: "Existing", learned: "Learned", manual: "Manual" }, extra: { keep: true },
  });
});

test("manual edits win conflicts and coalesce address case variants while inference only fills absent labels", async () => {
  const labels = createDeviceLabels(createMemoryDeviceLabelStorage(JSON.stringify({ devices: {
    ADDRESS: "Old", Address: "Another", blank: "", untouched: "  ",
  } })));
  await Promise.all([
    labels.setManual(["ADDRESS", "address"], "Manual"),
    labels.learnAlias("Address", "Inferred"),
    labels.learnAlias("BLANK", "Should not replace empty"),
    labels.learnAlias("NEW", "Learned"),
    labels.setManual(["New"], "Replaced"),
  ]);
  assert.deepEqual((await labels.read()).devices, {
    address: "Manual", blank: "", new: "Replaced", untouched: "  ",
  });
  await labels.setManual(["ADDRESS", "New"], "");
  await labels.learnAlias("ADDRESS", "Returned");
  assert.deepEqual((await labels.read()).devices, { address: "Returned", blank: "", untouched: "  " });
});

test("invalid configuration rejects reads and both mutation paths without replacing the contents", async () => {
  for (const raw of ["{broken", "null", "[]", "{}", '{"devices":[]}', '{"devices":null}',
    '{"devices":{"name":7}}']) {
    const storage = createMemoryDeviceLabelStorage(raw);
    const labels = createDeviceLabels(storage);
    await assert.rejects(labels.read(), /Device configuration/);
    await assert.rejects(labels.setManual(["manual"], "Manual"), /Device configuration/);
    await assert.rejects(labels.learnAlias("learned", "Learned"), /Device configuration/);
    assert.equal(await storage.read(), raw);
    await storage.write('{"devices":{}}');
    await labels.setManual(["recovered"], "Recovered");
    assert.deepEqual(await labels.read(), { devices: { recovered: "Recovered" } });
  }
});

test("file storage creates missing labels and preserves the previous file and cleans temporary files after write failures", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "hearth-labels-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "config", "devices.json");
  const labels = createDeviceLabels(createFileDeviceLabelStorage(path));
  assert.deepEqual(await labels.read(), { devices: {} });
  assert.deepEqual(await fs.readdir(root), []);
  await labels.setManual(["address"], "Original");
  const prior = await fs.readFile(path, "utf8");
  for (const failure of ["writeFile", "rename"]) {
    const failing = createDeviceLabels(createFileDeviceLabelStorage(path, { fs: {
      ...fs,
      [failure]: async (...args) => {
        if (failure === "writeFile") await fs.writeFile(args[0], "partial");
        throw new Error(`failed ${failure}`);
      },
    } }));
    await assert.rejects(failing.setManual(["address"], "Lost"), /failed/);
    assert.equal(await fs.readFile(path, "utf8"), prior);
    assert.deepEqual(await fs.readdir(join(root, "config")), ["devices.json"]);
  }
});

test("queued reads see earlier writes, failed operations release the queue, and read snapshots are independent", async () => {
  const storage = createMemoryDeviceLabelStorage('{"devices":{"existing":"Existing"},"extra":{"keep":true}}');
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const writing = new Promise((resolve) => { entered = resolve; });
  let fail = true;
  const labels = createDeviceLabels({ ...storage, async write(contents) {
    if (fail) {
      fail = false;
      entered();
      await gate;
      throw new Error("write denied");
    }
    await storage.write(contents);
  } });
  const failed = assert.rejects(labels.setManual(["lost"], "Lost"), /write denied/);
  await writing;
  const succeeding = labels.setManual(["kept"], "Kept");
  const reading = labels.read();
  release();
  await Promise.all([failed, succeeding]);
  assert.deepEqual(await reading, { devices: { existing: "Existing", kept: "Kept" }, extra: { keep: true } });
  const snapshot = await labels.read();
  snapshot.devices.kept = "Unsaved";
  snapshot.extra.keep = false;
  assert.deepEqual(await labels.read(), { devices: { existing: "Existing", kept: "Kept" }, extra: { keep: true } });
});

test("permission errors are not missing files and later operations reload successfully", async () => {
  const storage = createMemoryDeviceLabelStorage('{"devices":{"existing":"Existing"}}');
  let denied = true;
  const labels = createDeviceLabels({ ...storage, async read() {
    if (denied) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return storage.read();
  } });
  await assert.rejects(labels.read(), /permission denied/);
  await assert.rejects(labels.setManual(["lost"], "Lost"), /permission denied/);
  await assert.rejects(labels.learnAlias("lost", "Lost"), /permission denied/);
  assert.equal(await storage.read(), '{"devices":{"existing":"Existing"}}');
  denied = false;
  await labels.learnAlias("kept", "Kept");
  assert.deepEqual((await labels.read()).devices, { existing: "Existing", kept: "Kept" });
  const fileLabels = createDeviceLabels(createFileDeviceLabelStorage("unused", { fs: {
    readFile: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
  } }));
  await assert.rejects(fileLabels.read(), /permission denied/);
});

test("arbitrary existing string labels and prototype-sensitive keys survive mutations", async () => {
  const raw = '{"devices":{"__proto__":"Saved","UPPER":"","":"empty key","constructor":"Constructor"},"__proto__":{"keep":true}}';
  const labels = createDeviceLabels(createMemoryDeviceLabelStorage(raw));
  await labels.learnAlias("upper", "Blocked");
  await labels.setManual(["CONSTRUCTOR"], "Manual");
  await labels.learnAlias("toString", "Learned");
  const config = await labels.read();
  assert.deepEqual(config, JSON.parse('{"devices":{"__proto__":"Saved","UPPER":"","":"empty key","constructor":"Manual","tostring":"Learned"},"__proto__":{"keep":true}}'));
  await labels.setManual(["__PROTO__"], "");
  await labels.learnAlias("__PROTO__", "New");
  assert.equal((await labels.read()).devices.__proto__, "New");
});

test("overlapping manual edits preserve distinct addresses and order replacements", async () => {
  const labels = createDeviceLabels(createMemoryDeviceLabelStorage());
  await Promise.all([
    labels.setManual(["FIRST"], "First"),
    labels.setManual(["second"], "Second"),
    labels.setManual(["First"], "Replacement"),
  ]);
  assert.deepEqual(await labels.read(), { devices: { first: "Replacement", second: "Second" } });
});

test("invalid incoming labels cannot make previously valid configuration unreadable", async () => {
  const raw = '{"devices":{"existing":"Existing"}}';
  const storage = createMemoryDeviceLabelStorage(raw);
  const labels = createDeviceLabels(storage);
  await assert.rejects(labels.learnAlias("new", 42), /string labels/);
  await assert.rejects(labels.setManual(["existing"], { invalid: true }), /string labels/);
  assert.equal(await storage.read(), raw);
  await labels.learnAlias("new", "Valid");
  assert.deepEqual((await labels.read()).devices, { existing: "Existing", new: "Valid" });
});
