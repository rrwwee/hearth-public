# Frozen protocol-1 reconciliation compatibility fixture from 4fee12b.
# Only the original read-only activation helpers and reconciliation method are
# retained. Tests exercise these through deployment commands, without requiring
# Git history or the current implementation of the new evidence owner.
#!/usr/bin/env python3
# Hearth deployment protocol: 1
"""Activate a staged Hearth release, restoring the installation on failure.

Invoked by deploy-from-git.sh while it holds deploy.lock. Recovery material is
private and deliberately survives an interrupted or unsuccessful recovery.
"""
import json
import hashlib
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import uuid



SERVICE = "dashboard-hearth-web.service"
MANAGED = "# Managed by Hearth deployment.\n"
PROPERTIES = ["LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath",
              "DropInPaths", "WorkingDirectory", "ExecStart", "Environment",
              "EnvironmentFiles", "UnsetEnvironment"]


def run(*args, check=True):
    lock_fd = os.environ.get("HEARTH_DEPLOY_LOCK_FD")
    result = subprocess.run(args, text=True, capture_output=True, timeout=40,
                            pass_fds=(int(lock_fd),) if lock_fd else ())
    if check and result.returncode:
        raise RuntimeError(f"{shlex.join(args)} failed (exit {result.returncode}): {result.stderr.strip()[:2000]}")
    return result


def systemctl(*args, check=True):
    return run("systemctl", "--user", *args, check=check)


def service_state():
    result = systemctl("show", SERVICE, "--all", "--no-pager",
                       "--property=" + ",".join(PROPERTIES), check=False)
    values = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            # Unlike most properties, systemd prints one EnvironmentFiles
            # entry per line. Preserve their order and all private sources.
            values[key] = (values[key] + " " + value) if key == "EnvironmentFiles" and values.get(key) else value
    if not all(key in values for key in ("LoadState", "ActiveState", "UnitFileState")):
        raise RuntimeError("Cannot capture the service state")
    if result.returncode and values["LoadState"] != "not-found":
        raise RuntimeError("Cannot inspect the service")
    return values


def safe_path(path):
    if not path.is_absolute() or re.search(r"[\s\\\"'%]", str(path)):
        raise RuntimeError("Deployment paths must be absolute and contain no whitespace, quotes, backslashes or percent signs")
    return path


def atomic_copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name("." + destination.name + "." + uuid.uuid4().hex)
    try:
        shutil.copy2(source, temporary, follow_symlinks=False)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_text(path, text):
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    try:
        temporary.write_text(text)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def signature(path):
    if path.is_symlink():
        target = (stat.S_IMODE(path.stat().st_mode), path.read_bytes()) if path.is_file() else None
        return ("link", os.readlink(path), target)
    if not path.exists():
        return ("absent",)
    if not path.is_file():
        raise RuntimeError(f"Unsupported installation path: {path}")
    return ("file", stat.S_IMODE(path.stat().st_mode), path.read_bytes())


def environment_file(path):
    """Read systemd assignments without executing shell code or expansion.

    Support literal, quoted, and continued values. Reject ambiguous syntax
    instead of guessing at private installation configuration.
    """
    text = path.read_text()
    values = {}
    lines = iter(text.splitlines(keepends=True))
    for line in lines:
        line = line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise RuntimeError(f"Unsupported environment assignment in {path}")
        value = value.lstrip()
        quote = value[0] if value.startswith(("'", '"')) else ""
        if quote:
            while True:
                # A closing quote must not be escaped in double-quoted values.
                match = re.search(r"(?<!\\)" + re.escape(quote) + r"\s*$", value[1:]) if quote == '"' else re.search(re.escape(quote) + r"\s*$", value[1:])
                if match:
                    value = value[1:1 + match.start()]
                    break
                try:
                    value += "\n" + next(lines).rstrip("\n")
                except StopIteration as error:
                    raise RuntimeError(f"Unterminated environment quote in {path}") from error
            if quote == '"':
                value = re.sub(r"\\([\\\"`$])", r"\1", value).replace("\\\n", "")
        else:
            while value.endswith("\\"):
                try:
                    value = value[:-1] + next(lines).strip()
                except StopIteration as error:
                    raise RuntimeError(f"Unterminated environment continuation in {path}") from error
            value = re.sub(r"\\(.)", r"\1", value).strip()
        values[key] = value
    return values


def effective_environment(state):
    environment = dict(item.split("=", 1) for item in shlex.split(state.get("Environment", "")))
    source = state.get("EnvironmentFiles", "")
    files = re.findall(r"(\S+) \(ignore_errors=(yes|no)\)", source)
    if " ".join(f"{path} (ignore_errors={ignore})" for path, ignore in files) != source:
        raise RuntimeError("Unsupported service environment file layout")
    for name, ignore in files:
        path = safe_path(Path(name))
        if not path.exists() and ignore == "yes":
            continue
        environment.update(environment_file(path))
    for item in shlex.split(state.get("UnsetEnvironment", "")):
        key, separator, value = item.partition("=")
        if not separator or environment.get(key) == value:
            environment.pop(key, None)
    return environment, [Path(name) for name, _ in files]


def compatible_command(state):
    command = state.get("ExecStart", "")
    matches = re.findall(r"argv\[\]=([^;]*);", command)
    if len(matches) != 1:
        raise RuntimeError("Cannot identify the service start command")
    args = shlex.split(matches[0])
    if len(args) != 2 or Path(args[0]).name != "node" or args[1] != "server.js":
        raise RuntimeError("Custom ExecStart cannot be safely moved to the selected release")


def validate_port(port):
    if not re.fullmatch(r"[0-9]+", str(port)) or not 1 <= int(port) <= 65535:
        raise RuntimeError("Invalid service port")


def health(port):
    validate_port(port)
    result = run("curl", "--noproxy", "*", "--fail", "--silent", "--show-error",
                 "--max-time", "3", f"http://127.0.0.1:{port}/api/health", check=False)
    try:
        payload = json.loads(result.stdout)
        if result.returncode == 0 and payload.get("ok") is True and payload.get("mode") == "live" and isinstance(payload.get("release"), str):
            return payload["release"]
    except (ValueError, AttributeError):
        pass
    return None


def await_health(port, release):
    for attempt in range(20):
        if health(port) == release:
            return
        if attempt < 19:
            run("sleep", "1")
    raise RuntimeError("Service health did not identify the expected release")


import importlib.util
from deploy_protocol import require_commit


def reconcile(self, attempt, outcome):
    if outcome not in {"activated", "rolled-back", "failed-before-activation"}:
        raise RuntimeError("Choose activated, rolled-back or failed-before-activation")
    with self.locked(own=attempt, resolving=True):
        receipt = self.read(attempt)
        directory = self.directory(attempt)
        if outcome == "failed-before-activation":
            if receipt["phase"] not in {"preparation", "transfer", "verification", "staging", "validation"} or (directory / "unresolved.json").exists():
                raise RuntimeError("Cannot establish that activation never began")
        else:
            before = json.loads((directory / "activation-before.json").read_text())
            helper = self.releases / require_commit(receipt["commit"]) / "pi/dashboard/deploy_activation.py"
            spec = importlib.util.spec_from_file_location("hearth_activation", helper)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            state = module.service_state()
            first = before["service"]["LoadState"] == "not-found"
            active = "active" if outcome == "activated" and first else before["service"]["ActiveState"]
            enabled = "enabled" if outcome == "activated" and first else before["service"]["UnitFileState"]
            if state["ActiveState"] != active or state["UnitFileState"] != enabled:
                raise RuntimeError("Service policy does not match the proposed outcome")
            if state["LoadState"] != ("loaded" if outcome == "activated" else before["service"]["LoadState"]):
                raise RuntimeError("Service configuration does not match the proposed outcome")
            fingerprints = dict(before["operator_files"])
            if outcome == "rolled-back":
                fingerprints.update(before["previous_files"])
            for name, fingerprint in fingerprints.items():
                if hashlib.sha256(repr(module.signature(Path(name))).encode()).hexdigest() != fingerprint:
                    raise RuntimeError("Configuration does not match the proposed outcome: " + name)
            if outcome == "activated":
                if not self.current.is_symlink() or self.current.resolve() != (self.releases / receipt["commit"]).resolve():
                    raise RuntimeError("Selected release does not match the proposed outcome")
                identity = receipt["commit"]
                environment, _ = module.effective_environment(state)
                if environment.get("HEARTH_RELEASE") != identity or environment.get("HEARTH_AGENT") != str(self.current / "pi/dashboard/dashboard_agent.py"):
                    raise RuntimeError("Effective release settings do not match the proposed outcome")
                port = environment.get("PORT", "4173")
            else:
                identity, port = before["identity"], before["port"]
            if active == "active" and module.health(port) != identity:
                raise RuntimeError("Running release does not match the proposed outcome")
        self.save(receipt, phase="complete", outcome="reconciled", reconciled_outcome=outcome)
        (directory / "unresolved.json").unlink(missing_ok=True)
        self.clean(receipt)
        print("Reconciled " + attempt + ": " + outcome)
    return 0
