#!/usr/bin/env python3
"""External-command fixtures for the deployment CLI; never access live services."""
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tarfile
import time

root = Path(__file__).absolute().parent.parent
command = Path(sys.argv[0]).name
args = sys.argv[1:]
settings = json.loads((root / "fixture.json").read_text())
candidate = settings.get("commit", "b" * 40)
state_file = root / "service.json"
state = json.loads(state_file.read_text())
with (root / "commands.jsonl").open("a") as log:
    log.write(json.dumps([command, *args]) + "\n")


def save():
    state_file.write_text(json.dumps(state))


def effective():
    unit = root / "systemd/dashboard-hearth-web.service"
    files = ([unit] if unit.exists() else []) + sorted((unit.parent / (unit.name + ".d")).glob("*.conf"))
    values = {"Environment": [], "EnvironmentFiles": []}
    for path in files:
        for line in path.read_text().splitlines():
            key, separator, value = line.partition("=")
            if not separator:
                continue
            if key == "Environment":
                values[key].extend(shlex.split(value))
            elif key == "EnvironmentFile":
                if not value:
                    values["EnvironmentFiles"] = []
                else:
                    values["EnvironmentFiles"].append(value)
            elif key == "ExecStart":
                values[key] = "{ path=/usr/bin/node ; argv[]=" + value + " ; ignore_errors=no ; }"
            else:
                values[key] = value
    values["FragmentPath"] = str(unit) if unit.exists() else ""
    values["DropInPaths"] = " ".join(str(p) for p in files[1:])
    environment = dict(item.split("=", 1) for item in values["Environment"])
    for name in values["EnvironmentFiles"]:
        path = Path(name.lstrip("-"))
        if path.exists():
            for line in path.read_text().splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    key, value = line.split("=", 1)
                    environment[key] = value.strip().strip('"').strip("'")
    for item in shlex.split(values.get("UnsetEnvironment", "")):
        environment.pop(item.split("=", 1)[0], None)
    values["Environment"] = " ".join(shlex.quote(item) for item in values["Environment"])
    values["EnvironmentFiles"] = " ".join(name.lstrip("-") + " (ignore_errors=" + ("yes" if name.startswith("-") else "no") + ")" for name in values["EnvironmentFiles"])
    return values, environment


if command == "flock":
    try:
        fcntl.flock(int(args[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(1)
elif command == "git":
    if "get-url" in args:
        print("https://example.invalid/hearth.git")
    elif "rev-parse" in args:
        print(candidate)
    elif len(args) == 2 and args[0] == "show" and args[1].startswith(candidate + ":pi/dashboard/"):
        print((root / "source/pi/dashboard" / args[1].split("/")[-1]).read_text(), end="")
    elif "archive" in args:
        with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
            archive.add(root / "source", arcname=".")
    elif "fetch" not in args:
        sys.exit("unexpected fixture git command")
elif command == "npm":
    step = "fixtures" if args == ["test"] else "syntax"
    if settings.get("validationStepFailure") == step:
        sys.exit(23)
    if settings.get("checkValidationEnvironment") and args == ["test"]:
        forbidden = [key for key in os.environ if key.startswith("HEARTH_") or key == "PORT"
                     or (key.startswith("GIT_") and key not in {"GIT_NO_REPLACE_OBJECTS", "GIT_TERMINAL_PROMPT"})]
        if forbidden:
            sys.exit("Fixture validation inherited target settings: " + ", ".join(sorted(forbidden)))
        assert os.environ["VALIDATION_RUNTIME"] == "preserved"
        print("Fixture validation environment verified")
    if settings.get("validationFailure"):
        sys.exit(1)
elif command == "node":
    if settings.get("validationStepFailure") == "live-configuration":
        sys.exit(24)
    if settings.get("checkValidationEnvironment"):
        assert Path(os.environ["HEARTH_CONFIG_DIR"]).resolve() == (root / "config").resolve()
        assert Path(os.environ["HEARTH_STATE_DIR"]).resolve() == (root / "state").resolve()
        assert Path(os.environ["HEARTH_AGENT"]).resolve() == Path.cwd() / "pi/dashboard/dashboard_agent.py"
        assert os.environ["HEARTH_MODE"] == "live"
        assert os.environ["HEARTH_VALIDATE_ONLY"] == "1"
        assert os.environ["HEARTH_FUTURE_SETTING"] == "target-only"
        assert os.environ["PORT"] == "45123"
        print("Live validation environment verified")
    if settings.get("validationFailure"):
        sys.exit(1)
    if settings.get("blockActivationRecord"):
        for attempt in (root / "state/deploy-attempts").iterdir():
            receipt = attempt / "receipt.json"
            if json.loads(receipt.read_text()).get("phase") == "validation":
                receipt.unlink()
                receipt.mkdir()
elif command == "sleep":
    pass
elif command == "mv":
    # GNU mv -T semantics on the macOS test host.
    paths = [arg for arg in args if not arg.startswith("-")]
    os.replace(paths[-2], paths[-1])
elif command == "install":
    import shutil
    if settings.get("launcherFailure") and state.get("release") == candidate:
        sys.exit(1)
    shutil.copyfile(args[-2], args[-1])
    os.chmod(args[-1], 0o755)
elif command == "systemctl":
    operation = next(arg for arg in args if not arg.startswith("-"))
    if operation == "show":
        values, _ = effective()
        values.update({"LoadState": "loaded" if values["FragmentPath"] else "not-found",
                       "ActiveState": state["active"], "SubState": "running" if state["active"] == "active" else "dead",
                       "UnitFileState": state["enabled"]})
        if settings.get("masked"):
            values["LoadState"] = "masked"
        for key, value in values.items():
            if key == "EnvironmentFiles" and value:
                # systemctl show emits one repeated property per source file.
                for entry in re.findall(r"\S+ \(ignore_errors=(?:yes|no)\)", value):
                    print(key + "=" + entry)
            else:
                print(key + "=" + value)
    elif operation == "daemon-reload":
        state["reloads"] = state.get("reloads", 0) + 1
        save()
        if settings.get("reloadFailure") and state["reloads"] == 1:
            sys.exit(1)
    elif operation in ("start", "restart"):
        _, environment = effective()
        release = environment.get("HEARTH_RELEASE", "development")
        state["starts"] = state.get("starts", 0) + 1
        state["active"] = "active"
        state["release"] = release
        save()
        if settings.get("receiptFailure") and release == candidate:
            receipt = Path(os.environ["HEARTH_ACTIVATION_RESULT"]).with_name("receipt.json")
            receipt.unlink()
            receipt.mkdir()
        if settings.get("holdStart") and release == candidate:
            (root / "starting").touch()
            time.sleep(settings.get("holdSeconds", 30))
        if settings.get("restartFailure") and release == candidate:
            sys.exit(1)
        if settings.get("recoveryFailure") and state["starts"] > 1:
            sys.exit(1)
    elif operation == "stop":
        state["active"] = "inactive"
        save()
    elif operation == "reset-failed":
        # A stopped user unit can be collected between reload and this call.
        print("Unit not loaded", file=sys.stderr)
        sys.exit(1)
    elif operation in ("enable", "disable"):
        state["enabled"] = "enabled" if operation == "enable" else "disabled"
        save()
        if settings.get("enableFailure") and operation == "enable":
            sys.exit(1)
    else:
        sys.exit("unexpected fixture systemctl command: " + operation)
elif command == "curl":
    if state["active"] != "active":
        sys.exit(7)
    if args[-1] != "http://127.0.0.1:" + effective()[1].get("PORT", "4173") + "/api/health":
        sys.exit(7)
    release = state.get("release", "old-release-identity")
    if release == candidate:
        if settings.get("healthTimeout"):
            sys.exit(28)
        if settings.get("wrongRelease"):
            release = "unexpected-release"
        if settings.get("malformedHealth"):
            print('not-json "release":"' + release + '"')
            sys.exit(0)
    print(json.dumps({"ok": True, "mode": "live", "release": release}, separators=(",", ":")))
else:
    sys.exit("unrecognized fixture command")
