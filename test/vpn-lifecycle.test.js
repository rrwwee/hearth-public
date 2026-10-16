import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vpnTest as test, createVpnFixture as fixture, fixturePassword as password } from "./fixtures/vpn-fixture.js";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("both launcher paths replace the legacy VPN with one canonical connection", async (context) => {
  const f = await fixture(context);
  await writeFile(join(f.root, "hearth-uoe-vpn.service.state"), "active");
  const result = await f.start("start-uoe-vpn-from-stdin.sh").done;
  assert.equal(result.code, 0, result.stderr);
  const commands = await f.commands();
  assert.ok(commands.some(({ command, args }) => command === "systemctl" && args.includes("stop") && args.includes("hearth-uoe-vpn.service")));
  const launch = commands.find(({ command }) => command === "systemd-run");
  assert.ok(launch.args.includes("--unit=hearth-vpn"));
  assert.equal(await readFile(join(f.root, "state/vpn.pid"), "utf8"), "hearth-vpn.service\n");
  const vpn = commands.find(({ command }) => command === "openfortivpn");
  assert.ok(vpn.args.includes(`--trusted-cert=${"a".repeat(64)}`));
  assert.ok(vpn.args.includes("--pppd-ipparam=hearth-vpn"));
  assert.ok(vpn.args.includes("--set-routes=0"));
  assert.ok(vpn.args.includes("--set-dns=0"));
  assert.equal(vpn.passwordMatches, true);
  assert.equal(vpn.secretInEnvironment, false);
  assert.ok(!JSON.stringify(commands).includes(password));
  assert.deepEqual(await readdir(join(f.root, "tmp")), []);
  const second = await f.start().done;
  assert.equal(second.code, 0, second.stderr);
  assert.equal((await f.commands()).filter(({ command }) => command === "systemd-run").length, 2);
});

test("reconnect waits for delayed collection of the previous transient unit", async (context) => {
  const f = await fixture(context, { VPN_TEST_COLLECT_DELAY: "3" });
  await writeFile(join(f.root, "hearth-vpn.service.state"), "active");
  const result = await f.start().done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.commands()).filter(({ command }) => command === "systemd-run").length, 1);
  assert.equal(await readFile(join(f.root, "hearth-vpn.service.state"), "utf8"), "active");
});

test("reconnect refuses a replacement when the previous unit is not collected", async (context) => {
  // Forty subprocess polls can exceed the default watchdog on the Pi.
  const f = await fixture(context, { VPN_TEST_COLLECT_DELAY: "1000" }, { timeoutMs: 30000 });
  await writeFile(join(f.root, "hearth-vpn.service.state"), "active");
  const result = await f.start().done;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Cannot release hearth-vpn.service/);
  assert.ok(!(await f.commands()).some(({ command }) => command === "systemd-run"));
  assert.deepEqual(await readdir(join(f.root, "tmp")), []);
});

test("route failure leaves an existing VPN untouched", async (context) => {
  const f = await fixture(context, { VPN_TEST_ROUTE: "fail" });
  await writeFile(join(f.root, "hearth-vpn.service.state"), "active");
  const result = await f.start().done;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /gateway route.*existing VPN left running/);
  const commands = await f.commands();
  assert.ok(!commands.some(({ command, args }) => command === "systemd-run" || (command === "systemctl" && args.includes("stop"))));
  assert.equal(await readFile(join(f.root, "hearth-vpn.service.state"), "utf8"), "active");
});

test("an already-correct route is accepted and an absent certificate is omitted", async (context) => {
  const f = await fixture(context, { VPN_TEST_ROUTE: "existing", HEARTH_VPN_TRUSTED_CERT: "" });
  const result = await f.start().done;
  assert.equal(result.code, 0, result.stderr);
  const vpn = (await f.commands()).find(({ command }) => command === "openfortivpn");
  assert.ok(!vpn.args.some((arg) => arg.startsWith("--trusted-cert")));
});

test("overlapping attempts through different launchers are rejected, not queued", async (context) => {
  const f = await fixture(context, { VPN_TEST_LAUNCH_DELAY: "0.4" });
  const first = f.start("start-uoe-vpn-from-stdin.sh");
  await f.waitForCommand("systemd-run");
  const second = await f.start().done;
  assert.equal(second.code, 75, second.stderr);
  assert.match(second.stderr, /already in progress/);
  assert.equal((await first.done).code, 0);
  assert.equal((await f.commands()).filter(({ command }) => command === "systemd-run").length, 1);
});

for (const failure of ["VPN_TEST_LAUNCH_FAIL", "VPN_TEST_WORKER_FAIL", "VPN_TEST_NO_READER"]) {
  test(`${failure}: partial startup is stopped and temporary password files are removed`, async (context) => {
    const f = await fixture(context, { [failure]: "1" });
    const result = await f.start().done;
    assert.notEqual(result.code, 0);
    assert.deepEqual(await readdir(join(f.root, "tmp")), []);
    assert.equal(await readFile(join(f.root, "hearth-vpn.service.state"), "utf8"), "inactive");
    assert.ok(!JSON.stringify(await f.commands()).includes(password));
  });
}

test("cancelling startup cleans its process and releases the shared lock", async (context) => {
  const f = await fixture(context, { VPN_TEST_LAUNCH_DELAY: "0.4" });
  const first = f.start();
  await f.waitForCommand("systemd-run");
  first.child.kill("SIGTERM");
  assert.equal((await first.done).code, 143);
  assert.equal(await readFile(join(f.root, "hearth-vpn.service.state"), "utf8"), "inactive");
  assert.deepEqual(await readdir(join(f.root, "tmp")), []);
  const next = await f.start().done;
  assert.equal(next.code, 0, next.stderr);
});

test("a loose UOE launcher resolves the shared implementation from the current release", async (context) => {
  const f = await fixture(context);
  const base = join(f.root, "deployment");
  await mkdir(join(base, "current/pi/dashboard"), { recursive: true });
  await symlink(join(repo, "pi/dashboard/lib"), join(base, "current/pi/dashboard/lib"));
  const loose = join(f.root, "loose-launcher.sh");
  await copyFile(join(repo, "pi/dashboard/start-uoe-vpn-from-stdin.sh"), loose);
  f.env.HEARTH_BASE_DIR = base;
  const result = await f.start(loose).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.commands()).filter(({ command }) => command === "openfortivpn").length, 1);
});

test("installed route hooks accept both Hearth identities and ignore other tunnels", async (context) => {
  const f = await fixture(context);
  const installer = await readFile(join(repo, "pi/dashboard/install-vpn-route-hooks.sh"), "utf8");
  const hooks = [...installer.matchAll(/<<'HOOK'\n([\s\S]*?)\nHOOK/g)].map((match) => match[1]);
  assert.equal(hooks.length, 2);
  const config = join(f.root, "route-config");
  await writeFile(config, 'HEARTH_VPN_HOST=vpn.example.invalid\nHEARTH_VPN_ROUTES="198.51.100.0/24 203.0.113.0/24"\n');
  for (let index = 0; index < hooks.length; index++) {
    const path = join(f.root, `hook-${index}.sh`);
    await writeFile(path, hooks[index]);
    for (const tag of ["hearth-vpn", "hearth-uoe", "unrelated-vpn"]) {
      const before = (await f.commands()).length;
      // Substitute the installed config at its external filesystem seam.
      const result = await f.launch(["-c", 'source() { builtin source "$VPN_TEST_ROUTE_CONFIG"; }; export -f source; exec bash "$@"', "bash", path, "ppp-test", "", "", "", "", tag], {
        environment: { ...f.env, VPN_TEST_ROUTE_CONFIG: config },
      }).done;
      assert.equal(result.code, 0, result.stderr);
      const commands = (await f.commands()).slice(before);
      const routeChanges = commands.filter(({ command, args }) => command === "ip" && (args.includes("replace") || args.includes("del")));
      assert.equal(routeChanges.length, tag === "unrelated-vpn" ? 0 : 3, `${tag}: hook ${index}`);
    }
  }
});

test("reconnect succeeds when systemd collects stopped transient units", async (context) => {
  const f = await fixture(context, { VPN_TEST_COLLECT: "1" });
  for (const unit of ["hearth-uoe-vpn.service", "hearth-vpn.service"]) {
    await writeFile(join(f.root, `${unit}.state`), "active");
  }
  const result = await f.start().done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.commands()).filter(({ command }) => command === "systemd-run").length, 1);
});

for (const failure of ["VPN_TEST_STOP_FAIL", "VPN_TEST_RESET_FAIL"]) {
  test(`${failure}: a real lifecycle failure prevents starting another VPN`, async (context) => {
    const f = await fixture(context, { [failure]: "1" });
    await writeFile(join(f.root, "hearth-vpn.service.state"), "active");
    const result = await f.start().done;
    assert.notEqual(result.code, 0);
    assert.ok(!(await f.commands()).some(({ command }) => command === "systemd-run"));
  });
}
