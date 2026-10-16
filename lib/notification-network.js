import { advancePresence, completePresence, deviceLabel } from "./presence.js";

function formatElapsed(milliseconds) {
  const minutes = Math.max(1, Math.round(milliseconds / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function enqueueFirstSeen(enqueue, device) {
  const label = deviceLabel(device);
  const address = device.ip ? ` (${device.ip})` : "";
  enqueue(
    "network.first_seen",
    "New device seen on the network",
    `${label}${address} was seen for the first time.`,
    {
      tags: "mag",
      priority: "default",
      link: "network",
    },
  );
}

function hourStart(timestamp) {
  return Math.floor(timestamp / 3600000) * 3600000;
}

function enqueueHourlySummary(enqueue, state, now) {
  const targetHour = hourStart(now) - 3600000;
  if (targetHour < 0 || state.networkSummaryGeneratedHour >= targetHour) return;
  state.networkSummaryGeneratedHour = targetHour;
  const events = (state.networkEvents || [])
    .filter((event) => (
      event.timestamp >= targetHour
      && event.timestamp < targetHour + 3600000
      && ["away", "returned"].includes(event.type)
    ))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!events.length) return;

  const lines = events.slice(0, 20).map((event) => {
    const label = event.label || event.ip || "Unknown device";
    if (event.type === "returned") {
      return `${label} was seen again after ${formatElapsed(event.awayDurationMs || 0)}.`;
    }
    const unseenFor = Math.max(0, now - (event.lastSeen || event.timestamp));
    return `${label} was last seen ${formatElapsed(unseenFor)} ago.`;
  });
  if (events.length > lines.length) lines.push(`Plus ${events.length - lines.length} more changes.`);
  enqueue(
    "network.hourly_summary",
    "Network activity",
    `Period: ${new Date(targetHour).toISOString()} – ${new Date(targetHour + 3600000).toISOString()}\n${lines.join("\n")}`,
    { tags: "satellite", priority: "default", link: "network", hour: targetHour },
  );
}

export function createNetworkObserver({ collectNetwork, scanBluetooth, learnDeviceAlias, log, clock = Date.now }) {
  return async function observeNetwork(config, state, now, enqueue) {
    if (state.networkInitialized && now - (state.networkCheckedAt || 0) < config.networkPollMs) return;
    state.networkCheckedAt = now;
    const network = await collectNetwork();
    if (!network || !Array.isArray(network.devices) || network.devices.some((device) => (
      !device || typeof device !== "object" || Array.isArray(device)
    ))) throw new Error("Invalid network observation");

    const observedNow = clock();
    const update = advancePresence({ state, network, config, nowMs: observedNow });
    for (const { device, nickname } of update.aliasWrites) await learnDeviceAlias(device, nickname);
    let bluetooth;
    if (update.bluetoothScanDue) {
      try {
        bluetooth = await scanBluetooth(config);
      } catch (error) {
        await log("bluetooth.scan_error", { error: String(error.message).slice(0, 1200) });
      }
    }
    Object.assign(state, completePresence({ update, bluetooth, nowMs: observedNow }).state);
    for (const device of update.alerts) enqueueFirstSeen(enqueue, device);
    enqueueHourlySummary(enqueue, state, observedNow);
    if (state.networkObservedAt > 0) state.networkInitialized = true;
  };
}
