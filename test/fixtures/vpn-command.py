#!/usr/bin/env python3
import fcntl, json, os, pathlib, subprocess, sys, time
root = pathlib.Path(os.environ["VPN_TEST_ROOT"])
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
def record(**extra):
    with (root / "commands.jsonl").open("a") as f:
        f.write(json.dumps(dict(command=name, args=args, **extra)) + "\n")
def unit_path(unit):
    return root / (unit + ".state")
if name == "flock":
    try: fcntl.flock(int(args[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(1)
elif name == "sleep":
    time.sleep(min(float(args[0]), 0.02))
elif name == "getent":
    record()
    print("203.0.113.8 STREAM vpn.example.invalid")
elif name == "ip":
    record()
    if "default" in args:
        print("default via 192.0.2.1 dev eth0 metric 100")
        print("default via 192.0.2.2 dev wlan0 metric 600")
    elif "replace" in args:
        sys.exit(1 if os.environ.get("VPN_TEST_ROUTE") in ("fail", "existing") else 0)
    elif "del" in args:
        pass
    elif "get" in args:
        dev = "wrong0" if os.environ.get("VPN_TEST_ROUTE") == "fail" else "eth0"
        print("203.0.113.8 via 192.0.2.1 dev " + dev + " src 192.0.2.10")
    else: sys.exit(99)
elif name == "sudo":
    record()
    if args == ["-v"]: sys.exit(0)
    if args[0] == "-n": args = args[1:]
    os.execvp(args[0], args)
elif name == "systemctl":
    record()
    unit = next((x for x in args if x.endswith(".service")), "hearth-vpn.service")
    path = unit_path(unit)
    if "show" in args:
        pending = path.with_suffix(".collect")
        if pending.exists():
            remaining = int(pending.read_text())
            if remaining:
                pending.write_text(str(remaining - 1))
            else:
                path.unlink(missing_ok=True)
                pending.unlink()
        print("loaded" if path.exists() else "not-found")
    elif "is-active" in args: sys.exit(0 if path.exists() and path.read_text() == "active" else 3)
    elif "stop" in args:
        if os.environ.get("VPN_TEST_STOP_FAIL"): sys.exit(1)
        if os.environ.get("VPN_TEST_COLLECT"):
            path.unlink(missing_ok=True)
        else:
            path.write_text("inactive")
    elif "reset-failed" in args:
        if not path.exists() or os.environ.get("VPN_TEST_RESET_FAIL"): sys.exit(1)
        if os.environ.get("VPN_TEST_COLLECT_DELAY"):
            path.with_suffix(".collect").write_text(os.environ["VPN_TEST_COLLECT_DELAY"])
        else:
            path.unlink()
    else: sys.exit(99)
elif name == "systemd-run":
    record()
    if os.environ.get("VPN_TEST_LAUNCH_FAIL"): sys.exit(1)
    if unit_path("hearth-vpn.service").exists():
        print("Unit hearth-vpn.service was already loaded", file=sys.stderr)
        sys.exit(1)
    time.sleep(float(os.environ.get("VPN_TEST_LAUNCH_DELAY", "0")))
    unit_path("hearth-vpn.service").write_text("active")
    if os.environ.get("VPN_TEST_NO_READER"): sys.exit(0)
    start = args.index("--") + 1 if "--" in args else next(i for i, x in enumerate(args) if x == "/bin/bash")
    command = args[start:]
    # systemd consumes doubled dollars before executing the child.
    command = [x.replace("$$", "$") for x in command]
    with (root / "worker-output").open("ab") as log:
        subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True)
elif name == "openfortivpn":
    secret = sys.stdin.readline().rstrip("\n")
    record(passwordMatches=secret == (root / "expected-secret").read_text(),
           secretInEnvironment=bool(secret) and any(secret in value for value in os.environ.values()))
    if os.environ.get("VPN_TEST_WORKER_FAIL"):
        unit_path("hearth-vpn.service").write_text("failed")
        sys.exit(1)
else:
    sys.exit(99)
