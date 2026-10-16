import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const commit = "b".repeat(40);
const originalUnit = `[Unit]\nDescription=Private Hearth configuration\n[Service]\nWorkingDirectory=/legacy/hearth\nEnvironment=HEARTH_MODE=live HEARTH_AGENT_MODE=local HEARTH_RELEASE=old-release-identity\nExecStart=/usr/bin/node server.js\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;

async function fixture(context, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "hearth-deploy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["bin", "repository/.git", "systemd", "state", "config", "releases/old-directory", "source/public", "source/pi/dashboard"]) {
    await mkdir(join(root, path), { recursive: true });
  }
  await writeFile(join(root, "fixture.json"), JSON.stringify(settings));
  await writeFile(join(root, "service.json"), JSON.stringify({ active: settings.active || "active", enabled: settings.enabled || "disabled", release: "old-release-identity" }));
  const adapter = join(root, "bin/adapter.py");
  await copyFile(join(repo, "test/fixtures/deploy-command.py"), adapter);
  await chmod(adapter, 0o755);
  for (const name of ["git", "npm", "node", "flock", "systemctl", "curl", "sleep", "mv", "install"]) {
    await symlink(adapter, join(root, "bin", name));
  }
  await cp(join(repo, "pi/dashboard"), join(root, "source/pi/dashboard"), { recursive: true });
  await writeFile(join(root, "source/server.js"), "// validation fixture\n");
  await writeFile(join(root, "deploy-from-git.sh"), "previous stable launcher\n");
  const unit = join(root, "systemd/dashboard-hearth-web.service");
  if (!settings.firstInstall) {
    await symlink("releases/old-directory", join(root, "current"));
    await writeFile(unit, originalUnit);
    await mkdir(unit + ".d");
    await writeFile(join(unit + ".d", "10-private.conf"), "[Service]\nEnvironment=PRIVATE_SETTING=preserved\n");
  } else {
    await writeFile(join(root, "service.json"), JSON.stringify({ active: "inactive", enabled: "disabled" }));
  }
  const env = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HEARTH_DEPLOY_FIXTURE: root, HEARTH_BASE_DIR: root,
    HEARTH_SYSTEMD_USER_DIR: join(root, "systemd"),
    HEARTH_REPOSITORY_URL: "https://example.invalid/hearth.git",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const launch = (launcher = join(repo, "pi/dashboard/deploy-from-git.sh"), revision = "fixture") => {
    const child = spawn("bash", [launcher, revision], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    context.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    return { child, result: new Promise(resolve => child.on("close", code => resolve({ code, output }))) };
  };
  return { root, unit, launch, run: (...args) => launch(...args).result, state: async () => JSON.parse(await readFile(join(root, "service.json"), "utf8")) };
}

const legacyLauncher = '#!/usr/bin/env bash\nprintf "legacy launcher invoked\\n" > "$HEARTH_BASE_DIR/legacy-invoked"\nexit 99\n';

async function firstUpgrade(installation) {
  // Execute the documented procedure itself, with Git and service commands
  // confined to this temporary installation by the existing PATH adapters.
  const readme = await readFile(join(repo, "docs/live-reference.md"), "utf8");
  const procedure = readme.match(/```sh\n(# One-time launcher transition\n[\s\S]*?)\n```/);
  assert.ok(procedure, "Live reference must contain the first-upgrade procedure");
  const script = join(installation.root, "first-upgrade.sh");
  await writeFile(script, 'export HEARTH_UPGRADE_COMMIT="$1"\n' + procedure[1] + "\n");
  return installation.run(script, commit);
}

test("documented first upgrade bypasses the legacy launcher and preserves it after failed activation", async context => {
  const installation = await fixture(context, { restartFailure: true });
  const stable = join(installation.root, "deploy-from-git.sh");
  await writeFile(stable, legacyLauncher);
  await chmod(stable, 0o755);
  const result = await firstUpgrade(installation);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /Previous installation restored and verified/);
  assert.equal(await readFile(stable, "utf8"), legacyLauncher);
  await assert.rejects(lstat(join(installation.root, "legacy-invoked")), { code: "ENOENT" });
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory");
  assert.equal(await readFile(installation.unit, "utf8"), originalUnit);
  assert.equal((await installation.state()).release, "old-release-identity");
  assert.equal((await installation.state()).enabled, "disabled");
});

test("documented first upgrade installs the new launcher after success and later deployments use it", async context => {
  const installation = await fixture(context);
  const stable = join(installation.root, "deploy-from-git.sh");
  await writeFile(stable, legacyLauncher);
  await chmod(stable, 0o755);
  const result = await firstUpgrade(installation);
  assert.equal(result.code, 0, result.output);
  const reviewedLauncher = await readFile(join(repo, "pi/dashboard/deploy-from-git.sh"), "utf8");
  assert.equal(await readFile(stable, "utf8"), reviewedLauncher);
  assert.equal((await lstat(stable)).mode & 0o777, 0o755);
  assert.equal(await readFile(installation.unit, "utf8"), originalUnit);
  assert.equal((await installation.state()).enabled, "disabled");
  await assert.rejects(lstat(join(installation.root, "legacy-invoked")), { code: "ENOENT" });

  // A later activation failure must recover through the newly installed
  // launcher, without relying on the temporary first-upgrade copy.
  await writeFile(join(installation.root, "fixture.json"), JSON.stringify({ commit: "c".repeat(40), restartFailure: true }));
  const later = await installation.run(stable);
  assert.notEqual(later.code, 0, later.output);
  assert.match(later.output, /Previous installation restored and verified/);
  assert.equal(await readFile(stable, "utf8"), reviewedLauncher);
  assert.equal((await installation.state()).active, "active");
  assert.equal((await installation.state()).release, commit);
  assert.equal((await installation.state()).enabled, "disabled");
});

test("failed restart restores exact prior selection, configuration, identity and service policy", async context => {
  const installation = await fixture(context, { restartFailure: true });
  const result = await installation.run();
  assert.notEqual(result.code, 0, result.output);
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory", result.output);
  assert.equal(await readFile(installation.unit, "utf8"), originalUnit);
  assert.equal(await readFile(join(installation.root, "deploy-from-git.sh"), "utf8"), "previous stable launcher\n");
  assert.deepEqual(Object.fromEntries(Object.entries(await installation.state()).filter(([key]) => ["active", "enabled", "release"].includes(key))), {
    active: "active", enabled: "disabled", release: "old-release-identity",
  });
});

async function waitForStart(installation) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await lstat(join(installation.root, "starting")); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("fixture did not reach service startup");
}

test("terminating the deployment launcher recovers the previous release", { timeout: 8000 }, async context => {
  const installation = await fixture(context, { holdStart: true });
  const running = installation.launch();
  await waitForStart(installation);
  running.child.kill("SIGTERM");
  const result = await running.result;
  assert.notEqual(result.code, 0);
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory", result.output);
  assert.equal((await installation.state()).release, "old-release-identity");
});

test("successful activation preserves private configuration and disabled autostart", async context => {
  const installation = await fixture(context);
  const result = await installation.run();
  assert.equal(result.code, 0, result.output);
  assert.equal(await readlink(join(installation.root, "current")), join(installation.root, "releases", commit));
  assert.equal(await readFile(installation.unit, "utf8"), originalUnit);
  assert.equal(await readFile(join(installation.unit + ".d", "10-private.conf"), "utf8"), "[Service]\nEnvironment=PRIVATE_SETTING=preserved\n");
  assert.equal((await installation.state()).enabled, "disabled");
  assert.equal((await installation.state()).release, commit);
  await assert.rejects(lstat(join(installation.root, "state/deploy-recovery")), { code: "ENOENT" });
});

test("successful activation returns a previously inactive service to inactivity", async context => {
  const installation = await fixture(context, { active: "inactive", enabled: "enabled" });
  const result = await installation.run();
  assert.equal(result.code, 0, result.output);
  assert.equal((await installation.state()).active, "inactive");
  assert.equal((await installation.state()).enabled, "enabled");
  assert.equal((await installation.state()).starts, 1);
});

test("first installation starts the release and enables autostart", async context => {
  const installation = await fixture(context, { firstInstall: true });
  const result = await installation.run();
  assert.equal(result.code, 0, result.output);
  assert.equal((await installation.state()).active, "active");
  assert.equal((await installation.state()).enabled, "enabled");
});

for (const failure of ["reloadFailure", "wrongRelease", "healthTimeout", "malformedHealth", "launcherFailure"]) {
  test(`${failure} restores the prior installation`, async context => {
    const installation = await fixture(context, { [failure]: true });
    const result = await installation.run();
    assert.notEqual(result.code, 0, result.output);
    assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory", result.output);
    assert.equal(await readFile(installation.unit, "utf8"), originalUnit);
    assert.equal((await installation.state()).release, "old-release-identity");
    assert.equal((await installation.state()).enabled, "disabled");
    await assert.rejects(lstat(join(installation.root, "state/deploy-recovery")), { code: "ENOENT" });
  });
}

test("validation failure leaves the selected installation untouched", async context => {
  const installation = await fixture(context, { validationFailure: true });
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory");
  assert.equal((await installation.state()).starts, undefined);
});

test("failed first installation restores absence and disables its introduced service", async context => {
  const installation = await fixture(context, { firstInstall: true, restartFailure: true });
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  await assert.rejects(lstat(installation.unit), { code: "ENOENT" });
  await assert.rejects(lstat(join(installation.root, "current")), { code: "ENOENT" });
  assert.equal((await installation.state()).active, "inactive");
  assert.equal((await installation.state()).enabled, "disabled");
});

test("first installation creates a missing user systemd directory", async context => {
  const installation = await fixture(context, { firstInstall: true });
  await rm(join(installation.root, "systemd"), { recursive: true });
  const result = await installation.run();
  assert.equal(result.code, 0, result.output);
  assert.match(await readFile(installation.unit, "utf8"), /ExecStart=\/usr\/bin\/node server\.js/);
  assert.equal((await installation.state()).active, "active");
  assert.equal((await installation.state()).enabled, "enabled");
});

test("failed recovery retains private backups and blocks subsequent deployment", async context => {
  const installation = await fixture(context, { restartFailure: true, recoveryFailure: true });
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Recovery incomplete/);
  const bundle = join(installation.root, "state/deploy-recovery");
  assert.equal((await lstat(bundle)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(bundle, "1"), "utf8"), originalUnit);
  const starts = (await installation.state()).starts;
  const retry = await installation.run();
  assert.notEqual(retry.code, 0);
  assert.match(retry.output, /Unresolved deployment recovery/);
  assert.equal((await installation.state()).starts, starts);
});

test("a later custom override causes rollback instead of being overwritten", async context => {
  const installation = await fixture(context);
  const custom = join(installation.unit + ".d", "99-local.conf");
  await writeFile(custom, "[Service]\nWorkingDirectory=/private/custom/path\n");
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Custom configuration overrides/);
  assert.equal(await readFile(custom, "utf8"), "[Service]\nWorkingDirectory=/private/custom/path\n");
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory");
});

test("concurrent deployments are excluded while activation is running", { timeout: 8000 }, async context => {
  const installation = await fixture(context, { holdStart: true });
  const first = installation.launch();
  await waitForStart(installation);
  const second = await installation.run();
  assert.notEqual(second.code, 0);
  assert.match(second.output, /already running/);
  first.child.kill("SIGTERM");
  await first.result;
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory");
});

test("private environment files are preserved while their old release settings are replaced", async context => {
  const installation = await fixture(context);
  const privateFile = join(installation.root, "config/private.env");
  const contents = `HEARTH_RELEASE=old-release-identity\nHEARTH_AGENT=/legacy/agent.py\nHEARTH_VPN_HELPER=/private/vpn-helper\nPORT=4198\n`;
  await writeFile(privateFile, contents);
  await writeFile(join(installation.unit + ".d", "10-private.conf"), `[Service]\nEnvironmentFile=${privateFile}\n`);
  const result = await installation.run();
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(privateFile, "utf8"), contents);
  const calls = await readFile(join(installation.root, "commands.jsonl"), "utf8");
  assert.match(calls, /127\.0\.0\.1:4198/);
});

test("unobservable or masked service state is rejected before activation", async context => {
  const installation = await fixture(context, { masked: true });
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory");
  assert.equal((await installation.state()).starts, undefined);
});

test("rollback returns an originally inactive service to inactivity", async context => {
  const installation = await fixture(context, { active: "inactive", enabled: "enabled-runtime", wrongRelease: true });
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  assert.equal((await installation.state()).active, "inactive");
  assert.equal((await installation.state()).enabled, "enabled-runtime");
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory");
});

test("a linked main unit is preserved on successful deployment", async context => {
  const installation = await fixture(context);
  const target = join(installation.root, "custom-unit.service");
  await copyFile(installation.unit, target);
  await rm(installation.unit);
  await symlink(target, installation.unit);
  const result = await installation.run();
  assert.equal(result.code, 0, result.output);
  assert.equal(await readlink(installation.unit), target);
  assert.equal(await readFile(target, "utf8"), originalUnit);
});

test("partial first-install enablement failure restores the absent installation", async context => {
  const installation = await fixture(context, { firstInstall: true, enableFailure: true });
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  await assert.rejects(lstat(installation.unit), { code: "ENOENT" });
  assert.equal((await installation.state()).enabled, "disabled");
  assert.equal((await installation.state()).active, "inactive");
});

test("failed file restoration retains recovery material and does not restart an uncertain selection", { timeout: 8000 }, async context => {
  const installation = await fixture(context, { holdStart: true });
  const running = installation.launch();
  await waitForStart(installation);
  const selection = join(installation.root, "current");
  await rm(selection);
  await mkdir(selection);
  await writeFile(join(selection, "operator-file"), "keep this file");
  running.child.kill("SIGTERM");
  const result = await running.result;
  assert.match(result.output, /Recovery incomplete/);
  assert.match(result.output, /not restarted because its configuration could not be restored/);
  assert.equal((await installation.state()).starts, 1);
  assert.equal((await installation.state()).active, "inactive");
  assert.equal(await readFile(join(selection, "operator-file"), "utf8"), "keep this file");
  assert.ok((await lstat(join(installation.root, "state/deploy-recovery/snapshot.json"))).isFile());
});

test("an unmarked file at a managed configuration path is rejected without changing it", async context => {
  const installation = await fixture(context);
  const custom = join(installation.root, "config/hearth-release.env");
  await writeFile(custom, "PRIVATE_SETTING=keep\n");
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /contains custom configuration/);
  assert.equal(await readFile(custom, "utf8"), "PRIVATE_SETTING=keep\n");
  assert.equal(await readlink(join(installation.root, "current")), "releases/old-directory");
  assert.equal((await installation.state()).starts, undefined);
});

test("operator edits during activation prevent a recovery restart with uncertain configuration", { timeout: 8000 }, async context => {
  const installation = await fixture(context, { holdStart: true });
  const running = installation.launch();
  await waitForStart(installation);
  const custom = join(installation.unit + ".d", "10-private.conf");
  await writeFile(custom, "[Service]\nEnvironment=PRIVATE_SETTING=changed-by-operator\n");
  running.child.kill("SIGTERM");
  const result = await running.result;
  assert.match(result.output, /Recovery incomplete/);
  assert.equal((await installation.state()).starts, 1);
  assert.equal((await installation.state()).active, "inactive");
  assert.equal(await readFile(custom, "utf8"), "[Service]\nEnvironment=PRIVATE_SETTING=changed-by-operator\n");
});

test("failed migration of a legacy service restores an absent release selection", async context => {
  const installation = await fixture(context, { wrongRelease: true });
  await rm(join(installation.root, "current"));
  const result = await installation.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /restored and verified/);
  await assert.rejects(lstat(join(installation.root, "current")), { code: "ENOENT" });
  assert.equal(await readFile(installation.unit, "utf8"), originalUnit);
  assert.equal((await installation.state()).release, "old-release-identity");
  assert.equal((await installation.state()).active, "active");
});
