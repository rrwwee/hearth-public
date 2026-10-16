import { createHash, randomUUID } from "node:crypto";
import { createExclusiveRunner } from "./notification-delivery.js";
import { createNetworkObserver } from "./notification-network.js";
import { observeCluster } from "./notification-cluster.js";
import { NotificationConfigError } from "./notification-config.js";

export function createNotificationLoop({ run, getConfig, schedule = setTimeout }) {
  return async function loop() {
    const errors = [];
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
    try {
      let delay = 30000;
      try {
        const config = await getConfig();
        if (config.enabled) delay = config.pollMs;
      } catch (error) {
        if (!(error instanceof NotificationConfigError)) throw error;
      }
      schedule(loop, delay);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 1) throw new AggregateError(errors, "Notification run and rescheduling failed", { cause: errors[0] });
    if (errors.length) throw errors[0];
  };
}

function sequenceId(kind, key) {
  const prefix = kind.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 32);
  const digest = createHash("sha256").update(`${kind}:${key}`).digest("hex").slice(0, 24);
  return `hearth-${prefix}-${digest}`;
}

function appendEvent(state, domain, now, kind, title, message, options = {}) {
  const id = sequenceId(kind, options.key ?? options.hour ?? randomUUID());
  if (state.pending.some((event) => event.sequenceId === id)) return;
  const { key, ...metadata } = options;
  state.pending.push({ ...metadata, domain, kind, title, message, sequenceId: id,
    createdAt: now, lastAttemptAt: null });
}

export function createNotificationMonitor({ store, getConfig, collectCluster, collectNetwork,
  scanBluetooth, learnDeviceAlias, deliver, clock = Date.now, deliveryBudgetMs = 20000, log = async () => {} }) {
  const observeNetwork = createNetworkObserver({ collectNetwork, scanBluetooth, learnDeviceAlias, log, clock });
  return createExclusiveRunner(async () => {
    try {
      const config = await getConfig();
      if (!config.enabled) return;
      let state = await store.load();
      for (const domain of ["cluster", "network"]) {
        const draft = structuredClone(state);
        const now = clock();
        const enqueue = (...args) => appendEvent(draft, domain, now, ...args);
        try {
          if (domain === "cluster") {
            observeCluster(config, draft, await collectCluster(), clock(), enqueue);
          } else {
            await observeNetwork(config, draft, now, enqueue);
          }
        } catch (error) {
          await log(`notify.${domain}_monitor_error`, { error: error.message });
          continue;
        }
        await store.save(draft);
        state = draft;
      }
      const deadline = clock() + deliveryBudgetMs;
      const candidates = [...state.pending].sort((a, b) => (
        (a.lastAttemptAt ?? -1) - (b.lastAttemptAt ?? -1) || a.createdAt - b.createdAt
      ));
      while (candidates.length && clock() < deadline) {
        let index = candidates.findIndex((event) => event.domain === state.nextDeliveryDomain);
        if (index < 0) index = 0;
        const [event] = candidates.splice(index, 1);
        const currentConfig = await getConfig();
        if (!currentConfig.enabled || !currentConfig.topic) break;
        const attempted = structuredClone(state);
        attempted.nextDeliveryDomain = event.domain === "cluster" ? "network" : "cluster";
        attempted.pending.find((item) => item.sequenceId === event.sequenceId).lastAttemptAt = clock();
        await store.save(attempted);
        state = attempted;
        let accepted;
        try {
          const remaining = deadline - clock();
          if (remaining <= 0) break;
          accepted = await deliver({ ...currentConfig,
            deliveryTimeoutMs: Math.max(1, Math.min(currentConfig.deliveryTimeoutMs, remaining)) }, event);
        } catch (error) {
          await log("notify.error", { kind: event.kind, error: error.message });
          continue;
        }
        if (accepted !== true) continue;
        const acknowledged = structuredClone(state);
        acknowledged.pending = acknowledged.pending.filter((item) => item.sequenceId !== event.sequenceId);
        if (event.episodeId) acknowledged.passwordNotifiedAt = clock();
        if (event.kind === "network.hourly_summary") acknowledged.networkSummarySentHour = Math.max(acknowledged.networkSummarySentHour, event.hour);
        await store.save(acknowledged);
        state = acknowledged;
      }
    } catch (error) {
      if (!(error instanceof NotificationConfigError)) await log("notify.monitor_error", { error: error.message });
    }
  }, () => log("notify.monitor_overlap_skipped"));
}
