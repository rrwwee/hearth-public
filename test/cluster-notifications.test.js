import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createNotificationMonitor } from "../lib/notification-monitor.js";
import { createNotificationStateStore } from "../lib/notification-state.js";
import { fixtureEnvironment } from "./fixtures/environment.js";

const execute = promisify(execFile);
const job = "42|researcher|RUNNING|00:02:00|2026-10-11T12:00:00|1|gpu01|4|gpu:1|simulation\n";
const terminal = "41|researcher|COMPLETED|00:01:00|2026-10-11T11:00:00|2026-10-11T11:01:00|2026-10-11T11:02:00|finished\n";

test("real collector observations preserve jobs and durable alerts across failure and recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hearth-cluster-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const config = join(root, "config");
  await mkdir(bin);
  await mkdir(config);
  for (const command of ["ssh", "squeue", "sacct", "scontrol", "sinfo", "hostname", "klist", "getent"]) {
    await copyFile(new URL("./fixtures/cluster-command.py", import.meta.url), join(bin, command));
    await chmod(join(bin, command), 0o755);
  }
  await writeFile(join(config, "cluster.json"), JSON.stringify({
    sshHost: "fixture-compute", jumpHost: "fixture-jump", user: "researcher",
  }));
  const commandsFile = join(root, "commands.json");
  const env = fixtureEnvironment({ PATH: `${bin}${delimiter}${process.env.PATH}`, HEARTH_BASE_DIR: root,
    HEARTH_STATE_DIR: join(root, "state"), HEARTH_CONFIG_DIR: config,
    HEARTH_CLUSTER_PROBE_HOST: "", HEARTH_CLUSTER_JUMP: "fixture-jump",
    HEARTH_TEST_CLUSTER_FIXTURE: commandsFile, PYTHONDONTWRITEBYTECODE: "1" });
  let commands = { squeue: { stdout: job } };
  let accept = false;
  let now = Date.UTC(2026, 9, 11, 12);
  const attempts = [];
  const observations = [];
  const store = createNotificationStateStore(join(root, "notification-state.json"));
  const monitor = () => createNotificationMonitor({ store, clock: () => now,
    getConfig: async () => ({ enabled: true, topic: "fixture", reminderMs: 1800000, deliveryTimeoutMs: 1000 }),
    collectCluster: async () => {
      await writeFile(commandsFile, JSON.stringify(commands));
      const { stdout } = await execute("python3", [fileURLToPath(new URL("../pi/dashboard/dashboard_agent.py", import.meta.url)), "cluster"],
        { env, timeout: 15000 });
      const result = JSON.parse(stdout);
      observations.push(result);
      return result;
    },
    collectNetwork: async () => ({ devices: [], timestamp: now / 1000 }),
    scanBluetooth: async () => ({ available: false, devices: [] }),
    learnDeviceAlias: async () => {},
    deliver: async (_, event) => { attempts.push(event); return accept; },
  });
  await monitor()();
  assert.equal((await store.load()).jobs["42"].state, "RUNNING");
  assert.deepEqual(attempts, []);

  now += 30000;
  commands = { squeue: { exit: 1 }, sacct: { stdout: terminal } };
  await monitor()();
  assert.equal(observations.at(-1).queries.jobs.status, "failed");
  assert.equal((await store.load()).jobs["42"].state, "RUNNING");
  assert.deepEqual(attempts.map((event) => event.kind), ["job.completed"]);
  const terminalId = attempts[0].sequenceId;

  // Recreate the coordinator and reload persisted state on recovery.
  now += 30000;
  commands = { squeue: { stdout: job } };
  accept = true;
  await monitor()();
  assert.deepEqual(attempts.map((event) => event.kind), ["job.completed", "job.completed"]);
  assert.equal(attempts[1].sequenceId, terminalId);
  assert.deepEqual((await store.load()).pending, []);

  now += 30000;
  commands = {};
  await monitor()();
  assert.deepEqual((await store.load()).jobs, {});
  now += 30000;
  commands = { squeue: { stdout: job } };
  accept = false;
  await monitor()();
  assert.equal(attempts.at(-1).kind, "job.running");
  const startId = attempts.at(-1).sequenceId;
  now += 30000;
  commands = {};
  accept = true;
  await monitor()();
  assert.equal(attempts.at(-1).sequenceId, startId);
  assert.deepEqual((await store.load()).pending, []);
});
