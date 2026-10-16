import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "./environment.js";
import nodeTest from "node:test";

const repo = fileURLToPath(new URL("../..", import.meta.url));
export const fixturePassword = "fixture-only-password";
const adapter = await readFile(new URL("vpn-command.py", import.meta.url), "utf8");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = text => String(text).split(fixturePassword).join("[redacted]");
const outputLimit = 16 * 1024;
const fixtures = new WeakMap();
function bounded(value, limit) {
  const text = redact(value);
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 30) / 2);
  return text.slice(0, half) + "\n[long field omitted]\n" + text.slice(-half);
}

export function vpnTest(name, body) {
  return nodeTest(name, async context => {
    const owned = [];
    fixtures.set(context, owned);
    const errors = [];
    try { await body(context); } catch (error) { errors.push(error); }
    for (const f of owned) {
      const error = f.failure();
      if (error && !errors.includes(error)) errors.push(error);
    }
    for (const f of owned.toReversed()) {
      try { await f.close(errors[0]); } catch (error) { errors.push(error); }
    }
    fixtures.delete(context);
    if (errors.length) {
      const selected = [errors[0], ...errors.slice(1).slice(-7)];
      const details = selected.map(error => bounded(error.stack || error, 1024)).join("\n");
      const omitted = errors.length > selected.length ? `${errors.length - selected.length} additional errors omitted\n` : "";
      const report = owned.length ? await owned.at(-1).diagnostics() : "";
      throw new Error(`VPN scenario ${bounded(name, 256)} failed\n${details}\n${omitted}${report}`);
    }
  });
}

// Retain a possible split secret until the next chunk, then bound sanitized text.
function capture(stream) {
  let pending = "", text = "", truncated = false;
  function append(value) {
    text += value;
    if (text.length > outputLimit) { text = text.slice(-outputLimit); truncated = true; }
  }
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    pending += chunk;
    while (pending.length >= fixturePassword.length) {
      const index = pending.indexOf(fixturePassword);
      if (index !== -1) {
        append(pending.slice(0, index) + "[redacted]");
        pending = pending.slice(index + fixturePassword.length);
      } else {
        const end = pending.length - fixturePassword.length + 1;
        append(pending.slice(0, end));
        pending = pending.slice(end);
      }
    }
  });
  // Keep the look-behind buffer after EOF so snapshots use the same prefix
  // redaction before and after process cleanup.
  return () => {
    let suffix = redact(pending);
    for (let length = fixturePassword.length - 1; length > 0; length--) {
      if (suffix.endsWith(fixturePassword.slice(0, length))) {
        suffix = suffix.slice(0, -length) + "[redacted]";
        break;
      }
    }
    return (truncated ? "[earlier output omitted]\n" : "") + text + suffix;
  };
}

async function tail(path) {
  let file;
  try {
    file = await open(path);
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, outputLimit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (size > buffer.length) text = "[earlier output omitted]\n" + (text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "");
    return redact(text);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    return `[cannot read ${basename(path)}: ${error.code}]`;
  } finally { await file?.close(); }
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    // Darwin can return EPERM while only unreaped zombies remain in the group.
    // Keep waiting for ESRCH; a permissions error never confirms cleanup.
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function stopGroup(pid) {
  if (!pid || !groupExists(pid)) return;
  for (const [signal, grace] of [["SIGTERM", 250], ["SIGKILL", 1000]]) {
    try { process.kill(-pid, signal); }
    catch (error) { if (!["ESRCH", "EPERM"].includes(error.code)) throw error; }
    const deadline = Date.now() + grace;
    while (groupExists(pid) && Date.now() < deadline) await delay(10);
    if (!groupExists(pid)) return;
  }
  throw new Error(`Owned VPN fixture process group ${pid} did not terminate`);
}

export async function createVpnFixture(context, extraEnv = {}, { timeoutMs = 8000, diagnosticsDir = process.env.VPN_TEST_DIAGNOSTICS_DIR } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hearth-vpn-test-"));
  const runs = [];
  let closing, failure, finalReport;
  const scenario = context.name;
  const bin = join(root, "bin");

  async function diagnostics() {
    if (finalReport !== undefined) return finalReport;
    const files = await Promise.all(["commands.jsonl", "worker-output", "state/vpn.log"].map(async name => `${name}:\n${bounded(await tail(join(root, name)), 4096)}`));
    const selected = runs.slice(-8);
    const omitted = runs.length > selected.length ? `${runs.length - selected.length} earlier launches omitted\n` : "";
    const output = selected.map(run => `${bounded(run.name, 256)}: exit=${run.code === undefined ? "pending" : run.code} signal=${run.signal ?? "none"}\nstdout:\n${bounded(run.stdout(), 2048)}\nstderr:\n${bounded(run.stderr(), 2048)}`).join("\n");
    return `VPN fixture: ${bounded(scenario, 256)}\n${omitted}${output}\n${files.join("\n")}`;
  }
  async function fail(message) {
    failure = new Error(`${message}\n${await diagnostics()}`);
    return failure;
  }
  async function close(error) {
    if (error) failure = error;
    if (closing) return closing;
    closing = (async () => {
      const errors = [];
      for (const run of runs) {
        try { await stopGroup(run.child.pid); }
        catch (error) { errors.push(error); }
      }
      const stopped = errors.length === 0;
      const report = await diagnostics();
      finalReport = report;
      if (stopped) {
        try { await rm(root, { recursive: true, force: true }); }
        catch (error) { errors.push(error); }
      }
      if ((failure || errors.length) && diagnosticsDir) {
        try {
          await mkdir(diagnosticsDir, { recursive: true });
          await writeFile(join(diagnosticsDir, `${basename(root)}.log`), report, { mode: 0o600, flag: "wx" });
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, `VPN fixture cleanup failed: ${errors.map(error => redact(error.message)).join("; ")}\n${report}`);
    })();
    return closing;
  }
  const owner = fixtures.get(context);
  const publicFixture = { root, close, diagnostics };
  if (owner) owner.push({ ...publicFixture, failure: () => failure });
  else context.after(() => close());
  await mkdir(bin);
  await mkdir(join(root, "state"));
  await mkdir(join(root, "tmp"));
  await writeFile(join(root, "expected-secret"), fixturePassword, { mode: 0o600 });
  await writeFile(join(bin, "adapter"), adapter);
  await chmod(join(bin, "adapter"), 0o755);
  for (const name of ["flock", "getent", "ip", "sudo", "systemctl", "systemd-run", "openfortivpn"]) {
    await symlink("adapter", join(bin, name));
  }
  await mkdir(join(bin, "python"));
  await symlink("../adapter", join(bin, "python/sleep"));
  // Preserve the 20ms fixture cap while avoiding Python for polling waits.
  // Keep readiness sleeps on the original adapter: its startup also gives the
  // deliberately failing worker time to publish its status on slower hosts.
  await writeFile(join(bin, "sleep"), `#!/bin/sh
if [ "$#" = 1 ]; then
  case "$1" in 0.05) exec /bin/sleep 0.02 ;; esac
fi
exec python3 "$VPN_TEST_ROOT/bin/python/sleep" "$@"
`, { mode: 0o755 });
  const env = fixtureEnvironment({
    PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: join(root, "tmp"),
    XDG_RUNTIME_DIR: join(root, "runtime"), HEARTH_ENV_FILE: join(root, "missing.env"),
    HEARTH_STATE_DIR: join(root, "state"), HEARTH_VPN_HOST: "vpn.example.invalid",
    HEARTH_VPN_PORT: "443", HEARTH_VPN_USER: "researcher", HEARTH_VPN_TRUSTED_CERT: "a".repeat(64),
    VPN_TEST_ROOT: root, ...extraEnv,
  });
  async function commands() {
    try { return (await readFile(join(root, "commands.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  function launch(args, { environment = env, input = null } = {}) {
    if (closing) throw new Error("VPN fixture is closed");
    const child = spawn("bash", args, { env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const run = { child, name: args.join(" "), stdout: capture(child.stdout), stderr: capture(child.stderr) };
    runs.push(run);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const exited = new Promise(resolve => {
      child.once("error", error => { run.spawnError = error; resolve({ error }); });
      child.once("close", (code, signal) => { run.code = code; run.signal = signal; resolve({ code, signal }); });
    });
    let timer;
    const done = (async () => {
      try {
        const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs); })]);
        if (result.timeout) {
          let cleanup = "";
          try { await stopGroup(child.pid); } catch (error) { cleanup = `; ${error.message}`; }
          throw await fail(`VPN fixture watchdog expired after ${timeoutMs}ms${cleanup}`);
        }
        if (result.error) throw await fail(`VPN fixture could not launch: ${result.error.code}`);
        return { ...result, stdout: run.stdout(), stderr: run.stderr() };
      } finally { clearTimeout(timer); }
    })();
    done.catch(() => {}); // Teardown still owns a child when an assertion interrupts its caller.
    return { child, done };
  }
  function start(name = "start-vpn-from-stdin.sh") {
    return launch([name.startsWith("/") ? name : join(repo, "pi/dashboard", name)], { input: `${fixturePassword}\n` });
  }
  async function waitForCommand(command) {
    const deadline = Date.now() + 1500;
    do {
      if ((await commands()).some(entry => entry.command === command)) return;
      if (runs.length && runs.every(run => run.code !== undefined || run.spawnError)) {
        throw await fail(`VPN fixture exited before observing ${command}`);
      }
      await delay(10);
    } while (Date.now() < deadline);
    throw await fail(`VPN fixture did not observe ${command} within 1500ms`);
  }
  return Object.assign(publicFixture, { env, commands, start, launch, waitForCommand });
}
