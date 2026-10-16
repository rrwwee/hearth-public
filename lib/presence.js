function deviceKey(device) {
  return (device.mac || device.ip || "").toLowerCase();
}

function isMacAddress(value) {
  return /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(value || "");
}

function isPrivateMac(value) {
  return isMacAddress(value) && (Number.parseInt(value.slice(0, 2), 16) & 2) !== 0;
}

export function deviceLabel(device) {
  const name = device.nickname || device.name;
  if (name) return name;
  if (device.vendor && device.mac) return `${device.vendor} ${device.mac}`;
  return device.ip || device.mac || "unknown device";
}

function rememberNetworkEvent(state, type, device, now) {
  const events = state.networkEvents || [];
  const key = device.key || deviceKey(device);
  const duplicate = events.findLast?.((event) => (
    event.type === type && event.key === key && now - event.timestamp < 300_000
  ));
  if (duplicate) {
    Object.assign(duplicate, {
      timestamp: now, label: deviceLabel(device), ip: device.ip, mac: device.mac,
      bluetooth: device.bluetooth || duplicate.bluetooth,
      lastSeen: device.lastSeen || duplicate.lastSeen,
      awayDurationMs: device.awayDurationMs || duplicate.awayDurationMs,
    });
  } else {
    events.push({
      timestamp: now, type, key, label: deviceLabel(device), ip: device.ip, mac: device.mac,
      bluetooth: device.bluetooth || null,
      lastSeen: device.lastSeen || null,
      awayDurationMs: device.awayDurationMs || null,
    });
  }
  state.networkEvents = events.filter((event) => event.timestamp >= now - 26 * 60 * 60 * 1000);
}

function migratePresence(state, config, nowMs) {
  if (state.networkTrackingVersion !== 4) {
    if ((state.networkTrackingVersion || 0) < 3) state.networkEvents = [];
    for (const device of Object.values(state.networkDevices || {})) {
      device.present = nowMs - (device.lastSeen || 0) < config.networkAwayMs;
      device.pendingJoin = false;
      device.firstSeen = false;
      if (!device.onlineSince && device.lastSeen) {
        const observations = Math.max(1, Number(device.seenScans) || 1);
        device.onlineSince = Math.max(
          device.lastSeen - (observations - 1) * config.networkPollMs,
          device.lastSeen - 30 * 24 * 60 * 60 * 1000,
        );
      }
    }
    state.networkTrackingVersion = 4;
  }
  state.networkDevices = Object.fromEntries(
    Object.entries(state.networkDevices || {}).filter(([key]) => isMacAddress(key)),
  );
  state.networkEvents = (state.networkEvents || []).filter((event) => isMacAddress(event.mac));
}

function latestObservation(state) {
  return state.networkObservedAt || Math.max(0,
    ...Object.values(state.networkDevices || {}).map((device) => Number(device.lastSeen) || 0));
}

/**
 * Interpret one scan without I/O or mutation of the supplied notification state.
 * Network timestamps are seconds; all stored times and nowMs are milliseconds.
 * networkObservedAt deduplicates snapshots. Optional returnLastSeen and
 * returnObservedAt retain an unconfirmed return across persisted checkpoints.
 * These additive fields keep existing version-4 state readable.
 */
export function advancePresence({ state, network, config, nowMs }) {
  const next = structuredClone(state);
  const result = { state: next, alerts: [], aliasWrites: [], departures: [] };
  const observedAt = Number(network?.timestamp) * 1000;
  const lastObservedAt = latestObservation(next);
  if (!Array.isArray(network?.devices) || !Number.isFinite(observedAt) || observedAt <= 0
    || observedAt > nowMs || observedAt <= lastObservedAt) return result;
  migratePresence(next, config, nowMs);
  next.networkDevices ||= {};
  next.networkEvents ||= [];
  next.networkObservedAt = observedAt;
  const current = Object.fromEntries(network.devices
    .filter((device) => isMacAddress(deviceKey(device)))
    .map((device) => [deviceKey(device), structuredClone(device)]));
  const hasBaseline = Object.keys(next.networkDevices).length > 0;
  const { alerts, departures } = result;
  for (const [key, previous] of Object.entries(next.networkDevices)) {
    if (current[key]) continue;
    previous.missedScans = (previous.missedScans || 0) + 1;
    if (previous.pendingJoin) previous.seenScans = 0;
    if (!previous.missingSince) {
      previous.missingSince = observedAt;
      previous.bluetoothBefore = next.bluetoothSnapshot || null;
    }
    if (previous.present !== false && observedAt - (previous.lastSeen || 0) >= config.networkAwayMs) {
      previous.present = false;
      departures.push(structuredClone(previous));
    }
  }
  const claimedCandidates = new Set();
  if (hasBaseline) {
    for (const [key, device] of Object.entries(current)) {
      if (next.networkDevices[key]) continue;
      const candidates = Object.values(next.networkDevices).filter((candidate) => (
        !current[candidate.key] && !claimedCandidates.has(candidate.key)
        && candidate.missingSince
        && observedAt - candidate.missingSince <= config.networkIdentityWindowMs
        && isPrivateMac(candidate.mac) === isPrivateMac(device.mac)
      ));
      if (candidates.length === 1) {
        const candidate = candidates[0];
        claimedCandidates.add(candidate.key);
        device.identityKey = candidate.identityKey || candidate.key;
        device.nickname ||= candidate.nickname;
        device.inferredFrom = candidate.key;
        candidate.present = false;
        candidate.replacedBy = key;
        candidate.leftNotified = true;
        rememberNetworkEvent(next, "address_changed", device, nowMs);
        if (device.nickname) result.aliasWrites.push({ device, nickname: device.nickname });
      } else if (candidates.length > 1) {
        device.possibleIdentityKeys = candidates.map((candidate) => candidate.identityKey || candidate.key);
        device.identityConfidence = "uncertain";
        const labels = candidates.map((candidate) => (
          candidate.nickname || candidate.name || candidate.vendor || candidate.ip || candidate.key
        ));
        device.nickname = `uncertain: ${labels.slice(0, 3).join(" or ")}`;
        rememberNetworkEvent(next, "uncertain", device, nowMs);
      }
    }
  }
  for (const device of Object.values(current)) {
    const key = deviceKey(device);
    if (!isMacAddress(key)) continue;
    const previous = next.networkDevices[key] || {};
    const returning = previous.present === false && !previous.replacedBy;
    if (returning) {
      previous.seenScans = 0;
      previous.pendingJoin = true;
      previous.returning = true;
      previous.returnLastSeen = previous.lastSeen;
      previous.returnObservedAt = observedAt;
      previous.onlineSince = observedAt;
    }
    const seenScans = (previous.seenScans || 0) + 1;
    next.networkDevices[key] = {
      ...previous, ...device, key,
      identityKey: device.identityKey || previous.identityKey || key,
      present: true,
      lastSeen: observedAt,
      onlineSince: previous.onlineSince || observedAt,
      missingSince: null,
      missedScans: 0,
      seenScans,
      pendingJoin: previous.pendingJoin || (hasBaseline && !previous.key && !device.inferredFrom && !device.identityConfidence),
      firstSeen: previous.firstSeen || (hasBaseline && !previous.key && !device.inferredFrom && !device.identityConfidence),
    };
    const tracked = next.networkDevices[key];
    if (tracked.pendingJoin && seenScans >= config.networkJoinScans) {
      if (tracked.firstSeen) {
        rememberNetworkEvent(next, "first_seen", tracked, nowMs);
        alerts.push(tracked);
      } else {
        rememberNetworkEvent(next, "returned", {
          ...tracked,
          awayDurationMs: tracked.returnLastSeen
            ? tracked.returnObservedAt - tracked.returnLastSeen : config.networkAwayMs,
        }, nowMs);
      }
      tracked.pendingJoin = false;
      tracked.firstSeen = false;
      tracked.returning = false;
      delete tracked.returnLastSeen;
      delete tracked.returnObservedAt;
    }
  }
  result.bluetoothScanDue = departures.length > 0
    || nowMs - (next.bluetoothCheckedAt || 0) >= config.bluetoothPollMs;
  return result;
}

function displayStatus(lastSeen, nowMs, config) {
  const age = nowMs - lastSeen;
  return { status: age < config.networkOnlineGraceMs ? "online" : "offline", away: age >= config.networkAwayMs };
}

/** Preview a scan without committing it, then format the existing network API. */
export function projectPresence({ state, network, config, nowMs, names = {}, localOnlineSinceMs }) {
  const interpreted = advancePresence({ state, network, config, nowMs }).state;
  const trackedDevices = interpreted.networkDevices || {};
  const aliases = Object.fromEntries(Object.entries(names).map(([key, name]) => [key.toLowerCase(), name]));
  const nickname = (key, device) => aliases[key] || aliases[(device.ip || "").toLowerCase()] || device.nickname;
  const observedAt = Number(network?.timestamp) * 1000;
  const liveDevices = Number.isFinite(observedAt) && observedAt > 0 && observedAt <= nowMs
    && observedAt >= latestObservation(interpreted) && Array.isArray(network?.devices) ? network.devices : [];
  const devices = new Map();
  for (const device of liveDevices) {
    const key = deviceKey(device);
    const tracked = trackedDevices[key] || {};
    const lastSeen = Math.max(observedAt, Number(tracked.lastSeen) || 0);
    const localStart = device.mac ? null : localOnlineSinceMs;
    const status = displayStatus(lastSeen, nowMs, config);
    devices.set(key, {
      ...device,
      nickname: nickname(key, device) || tracked.nickname,
      lastSeen: Math.floor(lastSeen / 1000),
      onlineSince: Math.floor((tracked.onlineSince || localStart || lastSeen) / 1000),
      status: status.status,
      ...(status.status === "offline" ? { away: status.away } : {}),
    });
  }
  for (const [key, tracked] of Object.entries(trackedDevices)) {
    if (!isMacAddress(key) || devices.has(key) || tracked.replacedBy) continue;
    const lastSeen = Number(tracked.lastSeen) || 0;
    const name = nickname(key, tracked);
    if (!name && nowMs - lastSeen > config.networkUnknownRetentionMs) continue;
    devices.set(key, {
      ip: tracked.ip, mac: tracked.mac, vendor: tracked.vendor, name: tracked.name,
      nickname: name,
      lastSeen: Math.floor(lastSeen / 1000),
      onlineSince: Math.floor((tracked.onlineSince || lastSeen) / 1000),
      ...displayStatus(lastSeen, nowMs, config),
    });
  }
  const sortedDevices = [...devices.values()].sort((a, b) => (
    (a.status === "online" ? 0 : 1) - (b.status === "online" ? 0 : 1)
    || (a.status === "online"
      ? (a.onlineSince || a.lastSeen || 0) - (b.onlineSince || b.lastSeen || 0)
      : (b.lastSeen || 0) - (a.lastSeen || 0))
    || deviceLabel(a).localeCompare(deviceLabel(b))
  ));
  const counts = Object.fromEntries(["online", "offline"].map((status) => [
    status, sortedDevices.filter((device) => device.status === status).length,
  ]));
  return { ...network, devices: sortedDevices, counts };
}

function bluetoothDeviceKey(device) {
  return String(device?.address || "").toLowerCase();
}

function bluetoothDeviceLabel(device) {
  if (device?.name) return device.name;
  if ((device?.manufacturerIds || []).includes(76)) return "Apple device";
  return device?.address || "unknown Bluetooth device";
}

function compareBluetoothSnapshots(before, after) {
  if (!before?.available || !after?.available) {
    return {
      confidence: "unavailable",
      summary: "Bluetooth comparison unavailable",
      disappeared: [],
      appeared: [],
    };
  }
  const previous = new Map((before.devices || []).map((device) => [bluetoothDeviceKey(device), device]));
  const current = new Map((after.devices || []).map((device) => [bluetoothDeviceKey(device), device]));
  const disappeared = [...previous]
    .filter(([key]) => !current.has(key))
    .map(([, device]) => device);
  const appeared = [...current]
    .filter(([key]) => !previous.has(key))
    .map(([, device]) => device);
  const parts = [];
  if (disappeared.length) {
    parts.push(`Bluetooth missing: ${disappeared.slice(0, 3).map(bluetoothDeviceLabel).join(", ")}`);
  }
  if (appeared.length) {
    parts.push(`Bluetooth appeared: ${appeared.slice(0, 3).map(bluetoothDeviceLabel).join(", ")}`);
  }
  return {
    confidence: disappeared.length === 1 ? "possible" : (disappeared.length ? "ambiguous" : "none"),
    summary: parts.join("; ") || "no Bluetooth change observed",
    disappeared,
    appeared,
    beforeTimestamp: before.timestamp || null,
    afterTimestamp: after.timestamp || null,
  };
}

/** Attach a collected Bluetooth snapshot to pending departures, with no I/O. */
export function completePresence({ update, bluetooth, nowMs }) {
  const completed = structuredClone(update);
  if (bluetooth) {
    completed.state.bluetoothSnapshot = bluetooth;
    completed.state.bluetoothCheckedAt = nowMs;
  }
  for (const device of completed.departures) {
    rememberNetworkEvent(completed.state, "away", {
      ...device,
      bluetooth: compareBluetoothSnapshots(device.bluetoothBefore, bluetooth),
    }, nowMs);
    delete completed.state.networkDevices[device.key].bluetoothBefore;
  }
  return completed;
}
