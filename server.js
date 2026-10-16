import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { uptime } from "node:os";
import { access, appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { demoBluetooth, demoCluster, demoNetwork, demoSnapshot } from "./demo/fixtures.js";
import { sendNtfy } from "./lib/notification-delivery.js";
import { createNotificationLoop, createNotificationMonitor } from "./lib/notification-monitor.js";
import { createNotificationConfiguration, readNotificationConfig } from "./lib/notification-config.js";
import { createNotificationStateStore } from "./lib/notification-state.js";
import { projectPresence } from "./lib/presence.js";
import { createDeviceLabels, createFileDeviceLabelStorage } from "./lib/device-labels.js";
import { createDashboardAccessPolicy } from "./lib/dashboard-access.js";
import { createCredentialOutput, redactCredentialText } from "./lib/credential-output.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const appMode = (process.env.HEARTH_MODE || "demo").trim().toLowerCase();
if (!new Set(["demo", "live"]).has(appMode)) {
  throw new Error("HEARTH_MODE must be either 'demo' or 'live'.");
}
const demoMode = appMode === "demo";
const validateOnly = process.env.HEARTH_VALIDATE_ONLY === "1";
const setting = (name) => (process.env[name] || "").trim();
const requiredSetting = (name) => {
  const value = setting(name);
  if (!value) throw new Error(`${name} is required when HEARTH_MODE=live.`);
  return value;
};
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const bindHost = setting("HEARTH_BIND") || "127.0.0.1";
const dashboardAccess = createDashboardAccessPolicy({ port, ...(demoMode ? {} : {
  trustedClients: process.env.HEARTH_TRUSTED_CLIENTS,
  trustedProxies: process.env.HEARTH_TRUSTED_PROXIES,
  allowedOrigins: process.env.HEARTH_ALLOWED_ORIGINS,
}) });
const agentMode = demoMode ? "demo" : requiredSetting("HEARTH_AGENT_MODE");
if (!demoMode && !new Set(["local", "ssh"]).has(agentMode)) {
  throw new Error("HEARTH_AGENT_MODE must be either 'local' or 'ssh' in live mode.");
}
const piHost = demoMode ? "hearth-demo" : (agentMode === "ssh" ? requiredSetting("HEARTH_HOST") : setting("HEARTH_HOST") || "localhost");
const agentPath = demoMode ? "" : requiredSetting("HEARTH_AGENT");
const clusterPrincipal = setting("HEARTH_CLUSTER_PRINCIPAL");
const clusterJumpHost = setting("HEARTH_CLUSTER_JUMP");
const clusterProbeHost = setting("HEARTH_CLUSTER_PROBE_HOST");
const vpnHelperPath = setting("HEARTH_VPN_HELPER");
const release = setting("HEARTH_RELEASE") || "development";
const stateDir = demoMode ? join(__dirname, ".demo-state") : requiredSetting("HEARTH_STATE_DIR");
const configDir = demoMode ? join(__dirname, "demo") : requiredSetting("HEARTH_CONFIG_DIR");
const eventLogPath = join(stateDir, "hearth-events.jsonl");
const notificationStatePath = join(stateDir, "notification-state.json");
const notificationConfigPath = join(configDir, "notifications.json");
const devicesConfigPath = join(configDir, "devices.json");
const deviceLabels = createDeviceLabels(createFileDeviceLabelStorage(devicesConfigPath));
const notificationConfiguration = createNotificationConfiguration(notificationConfigPath, logEvent);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".svg", "image/svg+xml"],
]);

function safeText(value, maxLength = 1200) {
  return String(value ?? "")
    .replaceAll("\u0000", "")
    .slice(0, maxLength);
}

async function logEvent(event, fields = {}) {
  if (demoMode) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    source: "web",
    event,
    ...fields,
  });
  try {
    await mkdir(stateDir, { recursive: true });
    await appendFile(eventLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error(`diagnostic log failed: ${error.message}`);
  }
}

function runAgent(command, args = []) {
  if (demoMode) throw new Error("Agent execution is disabled in demo mode.");
  const traceId = randomUUID();
  const program = agentMode === "local" ? agentPath : "ssh";
  const commandArgs = agentMode === "local"
    ? [command, ...args]
    : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", piHost, agentPath, command, ...args];

  logEvent("agent.start", { traceId, command, mode: agentMode });
  return new Promise((resolve, reject) => {
    execFile(
      program,
      commandArgs,
      { timeout: command === "network" ? 45000 : 40000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          logEvent("agent.error", {
            traceId,
            command,
            code: error.code,
            signal: error.signal,
            stderr: safeText(stderr),
          });
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        try {
          const payload = JSON.parse(stdout);
          logEvent("agent.ok", {
            traceId,
            command,
            reachable: payload?.reachable,
            note: safeText(payload?.note, 240),
          });
          resolve(payload);
        } catch {
          logEvent("agent.bad_json", { traceId, command, stdout: safeText(stdout) });
          reject(new Error(`The Pi answered ${command}, but the response was not readable.`));
        }
      },
    );
  });
}

function requireDashboardAccess(request) {
  const result = dashboardAccess.check(request);
  if (!result.ok) throw new Error(result.error);
}

function readJsonBody(request, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Request body was not readable."));
      }
    });
    request.on("error", reject);
  });
}

function runSecretCommand(program, args, password, options = {}) {
  return new Promise((resolve, reject) => {
    const diagnosticText = (value, maxCharacters = 1200, maskSuffix = false) =>
      redactCredentialText(value, password, { diagnostic: true, maxCharacters, maskSuffix });
    const traceId = options.traceId || randomUUID();
    logEvent("secret.spawn", { traceId, program: diagnosticText(program), args: args.map(arg => diagnosticText(arg, 160)), timeout: options.timeout || 20000 });
    const child = spawn(program, args, {
      cwd: options.cwd,
      // Give cancellation ownership of the launcher and its foreground children.
      // The VPN worker runs separately under systemd and is stopped by its launcher.
      detached: true,
      env: { ...process.env, HEARTH_TRACE_ID: traceId, HEARTH_STATE_DIR: stateDir, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let terminationError;
    let killTimer;
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          logEvent("secret.signal_error", { traceId, signal, error: diagnosticText(error.message) });
        }
      }
    };
    const terminate = (error) => {
      if (terminationError) return;
      terminationError = error;
      signalGroup("SIGTERM");
      // A child ignoring TERM must not retain the pipes or the request guard.
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => {
      logEvent("secret.timeout", { traceId, program: diagnosticText(program) });
      terminate(new Error("Credential command timed out; please retry."));
    }, options.timeout || 20000);
    const stdoutCapture = createCredentialOutput(password);
    const stderrCapture = createCredentialOutput(password);
    child.stdout.on("data", chunk => stdoutCapture.write(chunk));
    child.stderr.on("data", chunk => stderrCapture.write(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      error.message = redactCredentialText(error.message, password);
      logEvent("secret.spawn_error", { traceId, program: diagnosticText(program), error: diagnosticText(error.message) });
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const stdout = stdoutCapture.finish();
      const stderr = stderrCapture.finish();
      logEvent("secret.close", {
        traceId,
        program: diagnosticText(program),
        code,
        stdout: diagnosticText(stdout, 1200, true),
        stderr: diagnosticText(stderr, 1200, true),
      });
      if (terminationError) {
        terminationError.message = redactCredentialText(terminationError.message, password);
        reject(terminationError);
      } else if (code === 0) {
        resolve({ stdout: redactCredentialText(stdout, password, { trim: true }), stderr: redactCredentialText(stderr, password, { trim: true }) });
      } else {
        reject(new Error(redactCredentialText(stderr || stdout || `${program} exited with code ${code}`, password, { trim: true })));
      }
    });
    // Early rejection (for example a busy helper) can close stdin before the
    // write completes. Let the child's exit status report that failure.
    child.stdin.on("error", (error) => {
      if (error.code === "EPIPE") return;
      clearTimeout(timer);
      terminate(error);
    });
    child.stdin.end(`${password}\n`);
  });
}

function canReachHost(host, port = 22, timeout = 4000) {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function connectCluster(password, traceId = randomUUID()) {
  if (!clusterPrincipal || !clusterJumpHost || !clusterProbeHost) {
    throw new Error("Cluster authentication is not configured. Set HEARTH_CLUSTER_PRINCIPAL, HEARTH_CLUSTER_JUMP, and HEARTH_CLUSTER_PROBE_HOST.");
  }
  await logEvent("cluster.connect.request", { traceId });
  const hasVpnPath = await canReachHost(clusterProbeHost);
  await logEvent("cluster.connect.vpn_path", { traceId, reachable: hasVpnPath });
  if (!hasVpnPath) {
    throw new Error("VPN is not connected yet. Send the VPN password first, then refresh cluster.");
  }

  await runSecretCommand("kinit", ["-f", clusterPrincipal], password, { timeout: 20000, traceId });

  await new Promise((resolve) => {
    execFile("ssh", ["-O", "exit", clusterJumpHost], { timeout: 5000 }, () => resolve());
  });

  await new Promise((resolve, reject) => {
    execFile(
      "ssh",
      ["-fN", "-o", "PreferredAuthentications=gssapi-with-mic", clusterJumpHost],
      { timeout: 12000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }
        resolve();
      },
    );
  });

  return { message: "cluster path refreshed", traceId };
}

let vpnConnectionInProgress = false;

async function connectVpn(password, traceId = randomUUID()) {
  if (!vpnHelperPath || !clusterProbeHost) {
    throw new Error("VPN authentication is not configured. Set HEARTH_VPN_HELPER and HEARTH_CLUSTER_PROBE_HOST.");
  }
  if (vpnConnectionInProgress) {
    throw new Error("VPN connection attempt already in progress.");
  }
  vpnConnectionInProgress = true;
  try {
    await logEvent("vpn.request", { traceId });
    await runSecretCommand(vpnHelperPath, [], password, { timeout: 6000, traceId });
    const hasVpnPath = await canReachHost(clusterProbeHost);
    await logEvent("vpn.post_check", { traceId, reachable: hasVpnPath });
    if (!hasVpnPath) {
      throw new Error("VPN process started; cluster access not yet verified. The VPN is left running to retry.");
    }
    await logEvent("vpn.accepted", { traceId });
    return { message: "vpn start requested", traceId };
  } finally {
    vpnConnectionInProgress = false;
  }
}

async function handleSecret(request) {
  if (demoMode) throw new Error("Credential actions are disabled in demo mode.");
  const traceId = randomUUID();
  await logEvent("secret.request", {
    traceId,
    remote: safeText(request.socket.remoteAddress, 80),
    forwardedProto: safeText(request.headers["x-forwarded-proto"], 40),
    host: safeText(request.headers.host, 160),
    origin: safeText(request.headers.origin, 240),
    agentMode,
  });
  if (agentMode !== "local") {
    await logEvent("secret.reject", { traceId, reason: "not_local" });
    throw new Error("Password actions only run on the Pi-hosted dashboard.");
  }
  if (request.headers["x-hearth-secret"] !== "1") {
    await logEvent("secret.reject", { traceId, reason: "origin_or_header" });
    throw new Error("Password request requires X-Hearth-Secret: 1.");
  }
  const admission = dashboardAccess.check(request);
  if (!admission.ok) {
    await logEvent("secret.reject", { traceId, reason: admission.reason });
    throw new Error(admission.error);
  }
  const body = await readJsonBody(request);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) throw new Error("Password is required.");
  await logEvent("secret.target", { traceId, target: safeText(body.target, 40), passwordLength: password.length });
  try {
    let payload;
    if (body.target === "cluster") payload = await connectCluster(password, traceId);
    else if (body.target === "vpn") payload = await connectVpn(password, traceId);
    else throw new Error("Unknown password target.");
    return { ...payload, message: redactCredentialText(payload.message, password) };
  } catch (error) {
    error.message = redactCredentialText(error.message, password);
    throw error;
  }
}

async function diagnosticsPayload() {
  if (demoMode) return { mode: "demo", events: [] };
  let events;
  try {
    const raw = await readFile(eventLogPath, "utf8");
    events = raw.trim().split("\n").filter(Boolean).slice(-160).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    events = [];
  }
  return { stateDir, events };
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function validateLiveConfiguration() {
  if (demoMode) throw new Error("HEARTH_VALIDATE_ONLY requires HEARTH_MODE=live.");

  try {
    if (agentMode === "local") await access(agentPath, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new Error("The configured local agent is not readable and executable.");
  }

  try {
    const stateInfo = await stat(stateDir);
    if (!stateInfo.isDirectory()) throw new Error();
    await access(stateDir, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new Error("The configured state directory is not an accessible directory.");
  }

  const readRequiredJson = async (path, label) => {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error(`${label} configuration is missing or is not a JSON object.`);
    }
  };

  await deviceLabels.read();

  await readNotificationConfig(notificationConfigPath);

  const cluster = await readRequiredJson(join(configDir, "cluster.json"), "Cluster");
  if (typeof cluster.scheduler !== "string" || typeof cluster.sshHost !== "string"
      || typeof cluster.jumpHost !== "string" || typeof cluster.user !== "string"
      || !Array.isArray(cluster.friends) || !Number.isFinite(Number(cluster.jobLimit))) {
    throw new Error("Cluster configuration has an invalid scheduler, SSH host, jump host, user, friends list, or job limit.");
  }
  const friendColors = cluster.friendColors || {};
  const allowedFriendColors = new Set(["red", "blue", "green", "yellow", "pink", "brown"]);
  if (typeof friendColors !== "object" || Array.isArray(friendColors)
      || Object.values(friendColors).some((color) => !allowedFriendColors.has(color))) {
    throw new Error("Cluster friendColors must map account IDs to red, blue, green, yellow, pink, or brown.");
  }

  let ntfy;
  try {
    ntfy = await readFile(join(configDir, "ntfy-server.yml"), "utf8");
  } catch {
    throw new Error("ntfy server configuration is missing or unreadable.");
  }
  if (!/^base-url\s*:/m.test(ntfy) || !/^listen-http\s*:/m.test(ntfy) || !/^cache-duration\s*:/m.test(ntfy)) {
    throw new Error("ntfy server configuration is missing a required setting.");
  }

  console.log("Live configuration validation passed: agent, state, devices, cluster, notifications, and ntfy.");
}

function deviceNameKeys(body) {
  return [body.key, body.mac, body.ip]
    .map((value) => safeText(value, 120).trim().toLowerCase())
    .filter((value) => value && /^[a-z0-9:.:-]+$/i.test(value));
}

async function handleDeviceName(request) {
  if (demoMode) throw new Error("Device changes are disabled in demo mode.");
  requireDashboardAccess(request);
  const body = await readJsonBody(request, 2048);
  const keys = [...new Set(deviceNameKeys(body))];
  const name = safeText(body.name, 80).trim();
  if (keys.length === 0) throw new Error("No device address was supplied.");

  await deviceLabels.setManual(keys, name);
  await logEvent("network.device_name", { keys, name: name || null });
  return { keys, name };
}

async function networkDashboardPayload(force = false) {
  const [network, state, config, namesConfig] = await Promise.all([
    runAgent("network", force ? ["--force"] : []),
    readJsonFile(notificationStatePath, {}),
    notificationConfiguration.getPresencePolicy(),
    deviceLabels.read(),
  ]);
  const nowMs = Date.now();
  return projectPresence({
    state, network, config, nowMs,
    names: namesConfig.devices || {},
    localOnlineSinceMs: nowMs - uptime() * 1000,
  });
}

async function scanBluetooth(config) {
  return runAgent("bluetooth", ["--scan", "--scan-seconds", String(config.bluetoothScanSeconds)]);
}

async function learnDeviceAlias(device, nickname) {
  if (!nickname) return;
  await deviceLabels.learnAlias(device.mac, nickname);
}

const runNotificationMonitor = createNotificationMonitor({
  store: createNotificationStateStore(notificationStatePath),
  getConfig: notificationConfiguration.getConfig,
  collectCluster: () => runAgent("cluster"),
  collectNetwork: () => runAgent("network", ["--force"]),
  scanBluetooth,
  learnDeviceAlias,
  log: (event, fields = {}) => logEvent(event, {
    ...fields, ...(fields.error ? { error: safeText(fields.error) } : {}),
  }),
  deliver: async (config, event) => {
    const response = await sendNtfy(config, {
      ...event,
      click: event.link === "network" ? config.networkUrl : config.dashboardUrl,
    });
    await logEvent("notify.sent", { kind: event.kind, title: event.title, status: response.status, ok: response.ok });
    return true;
  },
});

const notificationMonitorLoop = createNotificationLoop({
  run: runNotificationMonitor, getConfig: notificationConfiguration.getConfig,
});

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const routes = new Map([
  ["/api/snapshot", () => demoMode ? demoSnapshot() : runAgent("snapshot")],
  ["/api/network", (url) => demoMode ? demoNetwork() : networkDashboardPayload(url.searchParams.get("force") === "1")],
  ["/api/bluetooth", () => demoMode ? demoBluetooth() : runAgent("bluetooth")],
  ["/api/cluster", () => demoMode ? demoCluster() : runAgent("cluster")],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/health" && request.method === "GET") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ ok: true, mode: appMode, release }));
    return;
  }

  if (url.pathname === "/api/secret" && request.method === "POST") {
    try {
      const payload = await handleSecret(request);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: true, ...payload }));
    } catch (error) {
      response.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (url.pathname === "/api/diagnostics" && request.method === "GET") {
    const admission = dashboardAccess.check(request);
    if (!admission.ok) {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: admission.error }));
      return;
    }
    const payload = await diagnosticsPayload();
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ ok: true, diagnostics: payload }));
    return;
  }

  if (url.pathname === "/api/device-name" && request.method === "POST") {
    try {
      const payload = await handleDeviceName(request);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: true, ...payload }));
    } catch (error) {
      response.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  const handler = routes.get(url.pathname);

  if (handler) {
    try {
      const payload = await handler(url);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, [url.pathname.slice(5)]: payload, piHost, mode: appMode }));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: error.message, piHost }));
    }
    return;
  }

  await serveStatic(request, response);
});

if (validateOnly) {
  await validateLiveConfiguration();
} else {
  server.listen(port, bindHost, () => {
    console.log(`Hearth is glowing at http://${bindHost}:${port} (${appMode} mode)`);
    const source = demoMode ? "fictional in-process fixtures" : agentMode === "local" ? agentPath : `ssh ${piHost}:${agentPath}`;
    console.log(`Reading dashboard data from ${source}`);
    if (!demoMode) void notificationMonitorLoop();
  });
}
