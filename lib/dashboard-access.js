import { isIP } from "node:net";

function normalizeAddress(value) {
  if (typeof value !== "string" || value.includes("%") || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1);
  if (!/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(normalized)) return normalized;
  const [high, low] = normalized.slice(7).split(":").map((part) => Number.parseInt(part, 16));
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}

function addressList(value, name) {
  if (value === undefined || value === "") return new Set();
  if (typeof value !== "string") throw new Error(`${name} configuration must be a comma-separated list of IP addresses.`);
  return new Set(value.split(",").map((entry) => {
    const address = normalizeAddress(entry.trim());
    if (!address) throw new Error(`${name} configuration requires exact IPv4 or IPv6 addresses.`);
    return address;
  }));
}

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count;
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || !/^https?:\/\/[^\s/?#\\]+\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createDashboardAccessPolicy({ trustedClients, trustedProxies, allowedOrigins, port = 4173 } = {}) {
  const clients = addressList(trustedClients, "HEARTH_TRUSTED_CLIENTS");
  const proxies = addressList(trustedProxies, "HEARTH_TRUSTED_PROXIES");
  const origins = new Set(["127.0.0.1", "localhost", "[::1]"].map((host) => new URL(`http://${host}:${port}`).origin));
  if (allowedOrigins !== undefined && allowedOrigins !== "") {
    if (typeof allowedOrigins !== "string") throw new Error("HEARTH_ALLOWED_ORIGINS configuration must list HTTP(S) origins.");
    for (const entry of allowedOrigins.split(",")) {
      const origin = normalizeOrigin(entry.trim());
      if (!origin) throw new Error("HEARTH_ALLOWED_ORIGINS configuration requires HTTP(S) origins without credentials, paths, queries, or fragments.");
      origins.add(origin);
    }
  }
  return {
    check(request) {
      const peer = normalizeAddress(request.socket.remoteAddress);
      let scheme = "http";
      if (peer && proxies.has(peer)) {
        if (headerCount(request, "x-forwarded-proto") !== 1 || request.headers["x-forwarded-proto"] !== "https") {
          return { ok: false, reason: "proxy", error: "Dashboard proxy metadata must contain one X-Forwarded-Proto: https assertion." };
        }
        scheme = "https";
      } else if (!peer || !(peer === "::1" || peer.startsWith("127.") || clients.has(peer))) {
        return { ok: false, reason: "source", error: "Dashboard source is not approved for protected actions." };
      }
      const host = request.headers.host;
      const destination = typeof host === "string" && !/[\s/?#\\@]/.test(host) ? normalizeOrigin(`${scheme}://${host}`) : null;
      if (headerCount(request, "host") !== 1 || !destination || !origins.has(destination)) {
        return { ok: false, reason: "destination", error: "Dashboard destination is not an allowed origin." };
      }
      const origin = request.headers.origin;
      const originCount = headerCount(request, "origin");
      if (originCount > 1 || (origin !== undefined && (originCount !== 1 || normalizeOrigin(origin) !== destination))) {
        return { ok: false, reason: "origin", error: "Dashboard request Origin does not match its destination." };
      }
      return { ok: true };
    },
  };
}
