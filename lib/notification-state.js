import * as filesystem from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function newNotificationState() {
  return {
    version: 1, initialized: false, clusterInitialized: false, terminalInitialized: false, networkInitialized: false,
    jobs: {}, knownTerminalJobs: {}, jobNotificationVersion: 0,
    networkDevices: {}, networkEvents: [], networkCheckedAt: 0, networkTrackingVersion: 0,
    networkSummarySentHour: 0, networkSummaryGeneratedHour: 0,
    bluetoothSnapshot: null, bluetoothCheckedAt: 0,
    passwordNeed: null, passwordEpisodeId: null, passwordNotifiedAt: 0,
    pending: [], nextDeliveryDomain: "cluster",
  };
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const fail = (field) => { throw new Error(`Invalid notification state: ${field}`); };
const kinds = new Set(["job.running", "job.completed", "job.cancelled", "job.failed",
  "vpn.password_needed", "cluster.password_needed", "network.first_seen", "network.hourly_summary"]);

function validateState(state) {
  if (!object(state)) fail("expected an object");
  if (state.version !== undefined && state.version !== 1) fail("unsupported version");
  if (state.version === undefined) {
    // These fields identify checkpoints produced by the legacy monitor. An
    // arbitrary JSON object is not evidence of an empty or migratable state.
    for (const key of ["initialized", "jobs", "knownTerminalJobs", "networkDevices"]) {
      if (!Object.hasOwn(state, key)) fail(`unrecognized legacy state: missing ${key}`);
    }
  }
  if (state.version === 1) {
    for (const key of Object.keys(newNotificationState())) if (!Object.hasOwn(state, key)) fail(`missing ${key}`);
  }
  for (const field of ["initialized", "clusterInitialized", "terminalInitialized", "networkInitialized"]) {
    if (state[field] !== undefined && typeof state[field] !== "boolean") fail(field);
  }
  for (const field of ["networkCheckedAt", "networkSummarySentHour", "networkSummaryGeneratedHour",
    "bluetoothCheckedAt", "passwordNotifiedAt", "networkObservedAt"]) {
    if (state[field] !== undefined && !timestamp(state[field])) fail(field);
  }
  for (const [field, maximum] of [["jobNotificationVersion", 3], ["networkTrackingVersion", 4]]) {
    if (state[field] !== undefined && (!Number.isInteger(state[field]) || state[field] < 0 || state[field] > maximum)) fail(field);
  }
  for (const field of ["jobs", "networkDevices", "knownTerminalJobs"]) {
    if (state[field] !== undefined && !object(state[field])) fail(field);
  }
  for (const job of Object.values(state.jobs || {})) {
    if (!object(job) || typeof job.state !== "string" || !["string", "number"].includes(typeof job.id)) fail("job");
  }
  for (const seenAt of Object.values(state.knownTerminalJobs || {})) if (!timestamp(seenAt)) fail("terminal timestamp");
  for (const device of Object.values(state.networkDevices || {})) {
    if (!object(device)) fail("network device");
    for (const key of ["lastSeen", "onlineSince", "missingSince", "seenScans", "missedScans", "returnLastSeen", "returnObservedAt"]) {
      if (device[key] != null && !timestamp(device[key])) fail(`device ${key}`);
    }
    for (const key of ["present", "pendingJoin", "firstSeen", "returning"]) {
      if (device[key] !== undefined && typeof device[key] !== "boolean") fail(`device ${key}`);
    }
  }
  if (state.networkEvents !== undefined && !Array.isArray(state.networkEvents)) fail("network events");
  for (const event of state.networkEvents || []) {
    if (!object(event) || !timestamp(event.timestamp) || typeof event.type !== "string") fail("network event");
  }
  if (state.bluetoothSnapshot != null && !object(state.bluetoothSnapshot)) fail("Bluetooth snapshot");
  if (state.passwordNeed != null && !["vpn", "cluster"].includes(state.passwordNeed)) fail("password need");
  if (state.passwordEpisodeId != null && typeof state.passwordEpisodeId !== "string") fail("password episode");
  if (state.pending !== undefined && !Array.isArray(state.pending)) fail("pending records");
  if (state.nextDeliveryDomain !== undefined && !["cluster", "network"].includes(state.nextDeliveryDomain)) fail("delivery cursor");
  const ids = new Set();
  for (const event of state.pending || []) {
    if (!object(event) || !kinds.has(event.kind)) fail("pending kind");
    if (event.domain !== (event.kind.startsWith("network.") ? "network" : "cluster")) fail("pending domain");
    for (const field of ["sequenceId", "title", "message"]) {
      if (typeof event[field] !== "string" || !event[field]) fail(`pending ${field}`);
    }
    if (ids.has(event.sequenceId)) fail("duplicate pending identity");
    ids.add(event.sequenceId);
    if (!timestamp(event.createdAt) || (event.lastAttemptAt !== null && !timestamp(event.lastAttemptAt))) fail("pending timestamp");
    if (event.kind === "network.hourly_summary" && !timestamp(event.hour)) fail("summary hour");
    if (event.kind.endsWith(".password_needed") && typeof event.episodeId !== "string") fail("reminder episode");
    for (const field of ["tags", "priority"]) {
      if (event[field] !== undefined && typeof event[field] !== "string") fail(`pending ${field}`);
    }
    if (event.link !== undefined && !["network", "dashboard"].includes(event.link)) fail("pending link");
  }
}

function migrateState(state) {
  validateState(state);
  if (state.version === 1) return state;
  return {
    ...newNotificationState(), ...state, version: 1,
    clusterInitialized: state.initialized === true && state.jobNotificationVersion === 3,
    terminalInitialized: state.initialized === true && state.jobNotificationVersion === 3,
    networkInitialized: Boolean(state.initialized && state.networkTrackingVersion && state.networkDevices),
    networkSummaryGeneratedHour: state.networkSummarySentHour || 0,
  };
}

export function createNotificationStateStore(path, { fs = filesystem } = {}) {
  return {
    async load() {
      let raw;
      try {
        raw = await fs.readFile(path, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return newNotificationState();
        throw error;
      }
      return migrateState(JSON.parse(raw));
    },
    async save(state) {
      validateState(state);
      await fs.mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await fs.open(temporary, "wx", 0o600);
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
        await file.sync();
        await file.close();
        file = null;
        await fs.rename(temporary, path);
        const directory = await fs.open(dirname(path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        if (file) await file.close().catch(() => {});
        await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
      }
    },
  };
}
