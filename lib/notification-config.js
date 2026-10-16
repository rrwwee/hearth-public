import { readFile } from "node:fs/promises";

const numericSettings = {
  pollMs: [30000, 1000, 2147483647],
  deliveryTimeoutMs: [10000, 1000, Number.MAX_SAFE_INTEGER],
  networkPollMs: [30000, 1, Number.MAX_SAFE_INTEGER],
  networkJoinScans: [2, 1, Number.MAX_SAFE_INTEGER],
  networkOnlineGraceMs: [600000, 1, Number.MAX_SAFE_INTEGER],
  networkAwayMs: [2700000, 1, Number.MAX_SAFE_INTEGER],
  networkIdentityWindowMs: [2700000, 1, Number.MAX_SAFE_INTEGER],
  networkUnknownRetentionMs: [604800000, 1, Number.MAX_SAFE_INTEGER],
  bluetoothPollMs: [300000, 1, Number.MAX_SAFE_INTEGER],
  bluetoothScanSeconds: [8, 3, 20],
  reminderMs: [1800000, 1, Number.MAX_SAFE_INTEGER],
};

const defaults = Object.freeze({
  enabled: false, endpoint: "", topic: "", dashboardUrl: "", networkUrl: "", token: "", cache: true,
  ...Object.fromEntries(Object.entries(numericSettings).map(([key, [value]]) => [key, value])),
});

export class NotificationConfigError extends Error {
  constructor(field, reason) {
    super(`Notification configuration${field ? ` field ${JSON.stringify(field)}` : ""} ${reason}.`);
    this.name = "NotificationConfigError";
    this.field = field;
  }
}

function httpUrl(field, value, endpoint = false) {
  try {
    // eslint-disable-next-line no-control-regex -- Reject literal control characters before URL normalization can discard them.
    if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    if (endpoint && (value.includes("?") || value.includes("#"))) throw new Error();
    return url.href;
  } catch {
    throw new NotificationConfigError(field, `must be an absolute HTTP(S) URL without credentials${endpoint ? ", query, or fragment" : ""}`);
  }
}

export async function readNotificationConfig(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ...defaults };
    throw new NotificationConfigError(null, "could not be read");
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new NotificationConfigError(null, "must be valid JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new NotificationConfigError(null, "must be a JSON object");
  }
  if (typeof input.enabled !== "boolean") {
    throw new NotificationConfigError(null, "must declare enabled as true or false");
  }
  for (const field of Object.keys(input)) {
    if (!Object.hasOwn(defaults, field)) throw new NotificationConfigError(field, "is not recognized");
  }
  const config = { ...defaults, ...input };
  for (const [field, [, minimum, maximum]] of Object.entries(numericSettings)) {
    if (!Number.isSafeInteger(config[field]) || config[field] < minimum || config[field] > maximum) {
      throw new NotificationConfigError(field, `must be an integer from ${minimum} to ${maximum}`);
    }
  }
  for (const [earlier, later] of [
    ["networkOnlineGraceMs", "networkAwayMs"], ["networkAwayMs", "networkUnknownRetentionMs"],
  ]) {
    if (config[earlier] > config[later]) throw new NotificationConfigError(earlier, `must not exceed ${later}`);
  }
  if (input.enabled || Object.hasOwn(input, "endpoint")) config.endpoint = httpUrl("endpoint", input.endpoint, true);
  if (input.enabled || Object.hasOwn(input, "topic")) {
    try {
      if (typeof input.topic !== "string" || !input.topic.trim() || [".", ".."].includes(input.topic)) throw new Error();
      encodeURIComponent(input.topic);
    } catch {
      throw new NotificationConfigError("topic", "must be a nonblank Unicode string other than . or ..");
    }
  }
  for (const field of ["dashboardUrl", "networkUrl"]) {
    if (config[field] !== "") config[field] = httpUrl(field, config[field]);
  }
  try {
    if (typeof config.token !== "string") throw new Error();
    new Headers({ authorization: `Bearer ${config.token}` });
  } catch {
    throw new NotificationConfigError("token", "must be a string valid in an authorization header");
  }
  if (typeof config.cache !== "boolean") throw new NotificationConfigError("cache", "must be true or false");
  return config;
}

function presencePolicy(config) {
  return Object.fromEntries(Object.keys(numericSettings)
    .filter((field) => field.startsWith("network") || field.startsWith("bluetooth"))
    .map((field) => [field, config[field]]));
}

export function createNotificationConfiguration(path, log = async () => {}) {
  let lastPresencePolicy = presencePolicy(defaults);
  let lastError = null;
  async function getConfig() {
    let config;
    try {
      config = await readNotificationConfig(path);
    } catch (error) {
      if (!(error instanceof NotificationConfigError)) throw error;
      if (lastError !== error.message) {
        lastError = error.message;
        await log("notify.config_error", { error: error.message });
      }
      throw error;
    }
    lastPresencePolicy = presencePolicy(config);
    if (lastError !== null) {
      lastError = null;
      await log("notify.config_recovered");
    }
    return config;
  }
  return {
    getConfig,
    async getPresencePolicy() {
      try {
        await getConfig();
      } catch (error) {
        if (!(error instanceof NotificationConfigError)) throw error;
      }
      return { ...lastPresencePolicy };
    },
  };
}
