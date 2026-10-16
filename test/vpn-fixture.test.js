import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVpnFixture, fixturePassword } from "./fixtures/vpn-fixture.js";
import { execFile } from "node:child_process";
import { fixtureEnvironment } from "./fixtures/environment.js";

test("running-child diagnostics show short output without exposing a pending secret", async context => {
  const f = await createVpnFixture(context);
  const script = join(f.root, "pending.sh");
  await writeFile(script, 'printf "short-out\\n"\nprintf "short-err\\n" >&2\nprintf "%.7s" "$(cat "$VPN_TEST_ROOT/expected-secret")"\nprintf \'{"command":"output-ready"}\\n\' > "$VPN_TEST_ROOT/commands.jsonl"\n/bin/sleep 5\n');
  f.start(script);
  await f.waitForCommand("output-ready");
  const report = await f.diagnostics();
  assert.match(report, /short-out/);
  assert.match(report, /short-err/);
  assert.match(report, /\[redacted\]/);
  assert.match(report, /stdout:\nshort-out\n\[redacted\]\nstderr:\nshort-err/);
  await f.close();
  assert.match(await f.diagnostics(), /stdout:\nshort-out\n\[redacted\]\nstderr:\nshort-err/);
});

test("watchdog failures report redacted output and remove owned descendants and files", async context => {
  const f = await createVpnFixture(context, {}, { timeoutMs: 300 });
  const script = join(f.root, "blocked.sh");
  await writeFile(script, 'printf "captured-marker %s\\n" "$(cat "$VPN_TEST_ROOT/expected-secret")"\nprintf "stderr-marker\\n" >&2\n/bin/sleep 5 &\nprintf "%s" "$!" > "$VPN_TEST_ROOT/descendant.pid"\nwait\n');
  context.after(async () => {
    // Rescue the intentionally blocked child even if an assertion fails.
    try { process.kill(Number(await readFile(join(f.root, "descendant.pid"), "utf8")), "SIGKILL"); }
    catch (error) { if (!["ESRCH", "ENOENT"].includes(error.code)) throw error; }
  });
  await assert.rejects(f.start(script).done, error => {
    assert.match(error.message, /captured-marker/);
    assert.match(error.message, /stderr-marker/);
    assert.match(error.message, /watchdog failures report redacted output/);
    assert.ok(!error.message.includes(fixturePassword));
    return true;
  });
  const pid = Number(await readFile(join(f.root, "descendant.pid"), "utf8"));
  await f.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(stat(f.root), { code: "ENOENT" });
});

test("an early child exit explains a missing acknowledgement", async context => {
  const f = await createVpnFixture(context);
  const script = join(f.root, "exit.sh");
  await writeFile(script, 'printf "early-exit-marker\\n"\nexit 7\n');
  f.start(script);
  await assert.rejects(f.waitForCommand("systemd-run"), error => {
    assert.match(error.message, /before observing systemd-run/);
    assert.match(error.message, /exit=7/);
    assert.match(error.message, /early-exit-marker/);
    return true;
  });
});

test("retained diagnostics are bounded and never copy password files", async context => {
  const saved = await mkdtemp(join(tmpdir(), "hearth-vpn-diagnostics-"));
  context.after(() => rm(saved, { recursive: true, force: true }));
  const f = await createVpnFixture(context, {}, { timeoutMs: 500, diagnosticsDir: saved });
  const script = join(f.root, "noisy.sh");
  await writeFile(join(f.root, "noisy-input"), `noise-${fixturePassword}\n`.repeat(3000), { mode: 0o600 });
  for (const name of ["commands.jsonl", "worker-output", "state/vpn.log"]) {
    await writeFile(join(f.root, name), `record-${fixturePassword}\n`.repeat(3000), { mode: 0o600 });
  }
  await writeFile(script, 'secret="$(cat "$VPN_TEST_ROOT/expected-secret")"\ncat "$VPN_TEST_ROOT/noisy-input"\nprintf "tail-secret-%.7s" "$secret"\n/bin/sleep 0.02\nprintf "%s\\n" "${secret:7}"\nprintf "final-output-marker\\n"\n/bin/sleep 5\n');
  await assert.rejects(f.start(script).done, error => {
    assert.ok(error.message.length < 70 * 1024);
    assert.match(error.message, /final-output-marker/);
    assert.match(error.message, /earlier output omitted/);
    assert.match(error.message, /noisy\.sh: exit=/);
    assert.match(error.message, /commands\.jsonl:/);
    assert.match(error.message, /worker-output:/);
    assert.match(error.message, /state\/vpn\.log:/);
    assert.ok(!error.message.includes(fixturePassword));
    return true;
  });
  await f.close();
  const files = await readdir(saved);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.log$/);
  const report = await readFile(join(saved, files[0]), "utf8");
  assert.ok(!report.includes(fixturePassword));
  assert.match(report, /tail-secret-\[redacted\]/);
  assert.match(report, /final-output-marker/);
  assert.equal((await stat(join(saved, files[0]))).mode & 0o777, 0o600);
  await assert.rejects(stat(f.root), { code: "ENOENT" });
});

test("a scenario failure reports its output and cleanup failure without retaining private files", async context => {
  const root = await mkdtemp(join(tmpdir(), "hearth-vpn-probe-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const blocked = join(root, "blocked-diagnostics");
  await writeFile(blocked, "not a directory");
  const probe = join(root, "probe.test.mjs");
  const probeScript = `/bin/sleep 5 &
printf "%s" "$!" > "$VPN_TEST_ROOT/child-pid"
printf "scenario-output-marker\\n"
printf '{"command":"probe-ready"}\\n' > "$VPN_TEST_ROOT/commands.jsonl"
wait
`;
  await writeFile(probe, `
import { vpnTest, createVpnFixture } from ${JSON.stringify(new URL("./fixtures/vpn-fixture.js", import.meta.url).href)};
import { readFile, writeFile } from "node:fs/promises";
vpnTest("probe scenario", async context => {
  const f = await createVpnFixture(context, {}, { diagnosticsDir: ${JSON.stringify(blocked)} });
  await writeFile(${JSON.stringify(join(root, "fixture-root"))}, f.root);
  const script = f.root + "/marker.sh";
  await writeFile(script, ${JSON.stringify(probeScript)});
  f.start(script);
  await f.waitForCommand("probe-ready");
  await writeFile(${JSON.stringify(join(root, "child-pid"))}, await readFile(f.root + "/child-pid"));
  throw new Error("original-scenario-failure " + ${JSON.stringify(fixturePassword)} + "x".repeat(100000));
});
`);
  const env = fixtureEnvironment();
  delete env.NODE_TEST_CONTEXT;
  const result = await new Promise(resolve => execFile(process.execPath, ["--test", probe],
    { env, timeout: 5000 }, (error, stdout, stderr) => resolve({ error, output: stdout + stderr })));
  assert.equal(result.error?.code, 1, result.output);
  assert.match(result.output, /original-scenario-failure/);
  assert.match(result.output, /scenario-output-marker/);
  assert.match(result.output, /EEXIST/);
  assert.ok(!result.output.includes(fixturePassword));
  const pid = Number(await readFile(join(root, "child-pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(stat(await readFile(join(root, "fixture-root"), "utf8")), { code: "ENOENT" });
});

test("a spawn failure reports its cause and cleans its private directory", async context => {
  const f = await createVpnFixture(context);
  f.env.PATH = join(f.root, "missing-bin");
  await assert.rejects(f.start().done, /could not launch: ENOENT/);
  await f.close();
  await assert.rejects(stat(f.root), { code: "ENOENT" });
});
