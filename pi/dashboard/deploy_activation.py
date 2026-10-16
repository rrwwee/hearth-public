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
import signal
import stat
import subprocess
import sys
import uuid

from deploy_protocol import durable_json


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


class InstallationEvidence:
    """Own installation facts and the checks for each existing completion path.

    The persisted record remains protocol-1 compatible. Local activation keeps
    exact signatures; reconciliation compares the retained fingerprints.
    """

    def __init__(self, record, operator_signatures=None, previous_paths=()):
        self.record = record
        self.operator_signatures = operator_signatures
        self.previous_paths = previous_paths

    @classmethod
    def capture(cls, service, identity, port, operator_files, previous_paths):
        return cls({
            "service": dict(service),
            "identity": identity, "port": port,
        }, operator_signatures=dict(operator_files), previous_paths=tuple(previous_paths))

    def snapshot(self):
        def fingerprints(paths):
            return {str(path): hashlib.sha256(repr(signature(path)).encode()).hexdigest() for path in paths}

        return {**self.record,
                "service": {key: self.record["service"][key]
                            for key in ("LoadState", "ActiveState", "SubState", "UnitFileState")},
                "operator_files": fingerprints(self.operator_signatures),
                "previous_files": fingerprints(self.previous_paths)}

    def verify_unchanged(self):
        for path, prior in self.operator_signatures.items():
            if signature(path) != prior:
                raise RuntimeError(f"Operator configuration changed during deployment: {path}")

    def verify_policy(self, state, outcome, error):
        before = self.record["service"]
        first_activation = outcome == "activated" and before["LoadState"] == "not-found"
        active = "active" if first_activation else before["ActiveState"]
        enabled = "enabled" if first_activation else before["UnitFileState"]
        if state["ActiveState"] != active or state["UnitFileState"] != enabled:
            raise RuntimeError(error)

    def verify_candidate(self, current, commit, environment_file):
        candidate = service_state()
        self.verify_unchanged()
        compatible_command(candidate)
        environment, files = effective_environment(candidate)
        if candidate.get("WorkingDirectory") != str(current) or not files or files[-1] != environment_file:
            raise RuntimeError("Custom configuration overrides deployment release settings")
        expected = {"HEARTH_RELEASE": commit, "HEARTH_AGENT": str(current / "pi/dashboard/dashboard_agent.py"),
                    "HEARTH_MODE": "live", "HEARTH_AGENT_MODE": "local"}
        if any(environment.get(key) != value for key, value in expected.items()):
            raise RuntimeError("Effective service environment conflicts with activation")
        return environment

    def verify_activation(self):
        self.verify_policy(service_state(), "activated", "Service running/autostart policy does not match the intended state")
        self.verify_unchanged()

    def verify_rollback(self):
        self.verify_policy(service_state(), "rolled-back", "previous running/autostart state was not restored")
        self.verify_unchanged()

    def verify_reconciliation(self, outcome, current, release):
        before = self.record
        state = service_state()
        self.verify_policy(state, outcome, "Service policy does not match the proposed outcome")
        if state["LoadState"] != ("loaded" if outcome == "activated" else before["service"]["LoadState"]):
            raise RuntimeError("Service configuration does not match the proposed outcome")
        fingerprints = dict(before["operator_files"])
        if outcome == "rolled-back":
            fingerprints.update(before["previous_files"])
        for name, fingerprint in fingerprints.items():
            if hashlib.sha256(repr(signature(Path(name))).encode()).hexdigest() != fingerprint:
                raise RuntimeError("Configuration does not match the proposed outcome: " + name)
        if outcome == "activated":
            if not current.is_symlink() or current.resolve() != release.resolve():
                raise RuntimeError("Selected release does not match the proposed outcome")
            identity = release.name
            environment, _ = effective_environment(state)
            if environment.get("HEARTH_RELEASE") != identity or environment.get("HEARTH_AGENT") != str(current / "pi/dashboard/dashboard_agent.py"):
                raise RuntimeError("Effective release settings do not match the proposed outcome")
            port = environment.get("PORT", "4173")
        else:
            identity, port = before["identity"], before["port"]
        if state["ActiveState"] == "active" and health(port) != identity:
            raise RuntimeError("Running release does not match the proposed outcome")


def verify_installation_outcome(evidence_path, outcome, current, release):
    """Read-only reconciliation entry point for coordinators supporting it.

    Keep service_state, signature, effective_environment and health available:
    older protocol-1 coordinators still call those names on this module.
    """
    evidence = InstallationEvidence(json.loads(evidence_path.read_text()))
    evidence.verify_reconciliation(outcome, current, release)


class Activation:
    def __init__(self, release, commit):
        self.release = safe_path(Path(release))
        self.commit = commit
        self.base = safe_path(Path(os.environ["HEARTH_BASE_DIR"]))
        self.current = safe_path(Path(os.environ["HEARTH_CURRENT_LINK"]))
        self.state_dir = safe_path(Path(os.environ["HEARTH_STATE_DIR"]))
        self.config = safe_path(Path(os.environ["HEARTH_CONFIG_DIR"]))
        self.unit = safe_path(Path(os.environ["HEARTH_SYSTEMD_USER_DIR"])) / SERVICE
        self.dropin_dir = self.unit.with_name(SERVICE + ".d")
        self.dropin = self.dropin_dir / "50-hearth-release.conf"
        self.environment = self.config / "hearth-release.env"
        self.launcher = self.base / "deploy-from-git.sh"
        self.support = self.base / "deploy_protocol.py"
        self.bundle = self.state_dir / "deploy-recovery"
        self.entries = []
        self.unchanged = {}
        self.mutated = False
        self.outcome = None

    def prepare(self):
        validate_port(os.environ.get("PORT", "4173"))
        if self.bundle.exists() or self.bundle.is_symlink():
            completed = self.bundle / "completed"
            if self.bundle.is_symlink() or not completed.is_file():
                raise RuntimeError(f"Unresolved deployment recovery at {self.bundle}; resolve it before deploying again")
            shutil.rmtree(self.bundle)
        if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", self.commit) or (self.release / ".hearth-release").read_text().strip() != self.commit:
            raise RuntimeError("Staged release identity does not match the requested commit")
        self.before = service_state()
        self.first = self.before["LoadState"] == "not-found"
        if self.first:
            if signature(self.unit) != ("absent",) or signature(self.current) != ("absent",) or self.dropin_dir.exists() or self.dropin_dir.is_symlink():
                raise RuntimeError("Unloaded installation files require manual reconciliation")
            if self.before["ActiveState"] != "inactive":
                raise RuntimeError("Unexpected first-install service state")
            self.old_environment = {}
            files = []
        else:
            if self.before["LoadState"] != "loaded" or self.before["ActiveState"] not in ("active", "inactive"):
                raise RuntimeError("Unsupported service state; leave the installation unchanged")
            if self.before.get("SubState") != {"active": "running", "inactive": "dead"}[self.before["ActiveState"]]:
                raise RuntimeError("The service is not in a stable running or stopped state")
            if self.before["UnitFileState"] not in ("enabled", "disabled", "enabled-runtime", "linked", "linked-runtime", "static", "indirect"):
                raise RuntimeError("Unsupported service autostart state")
            if not self.unit.is_file() or Path(self.before.get("FragmentPath", "")).resolve() != self.unit.resolve():
                raise RuntimeError("The loaded service is not the configured installation unit")
            compatible_command(self.before)
            self.old_environment, files = effective_environment(self.before)
            if self.old_environment.get("HEARTH_MODE") != "live":
                raise RuntimeError("Existing service is not configured for live mode")
            if self.old_environment.get("HEARTH_AGENT_MODE") != "local":
                raise RuntimeError("Existing service is not configured for a local agent")
            if self.current.exists() and not self.current.is_symlink():
                raise RuntimeError("Current release selection is not a symlink")
        self.old_port = self.old_environment.get("PORT", "4173")
        validate_port(self.old_port)
        self.old_identity = self.old_environment.get("HEARTH_RELEASE", "development")
        if self.before["ActiveState"] == "active":
            self.old_identity = health(self.old_port)
            if self.old_identity is None:
                raise RuntimeError("Cannot establish the running release identity before activation")
        for name in shlex.split(self.before.get("DropInPaths", "")):
            path = safe_path(Path(name))
            if path != self.dropin:
                self.unchanged[path] = signature(path)
        for path in files:
            if path != self.environment:
                self.unchanged[path] = signature(path)
        if not self.first:
            self.unchanged[self.unit] = signature(self.unit)
        for path in (self.dropin, self.environment):
            if (path.exists() or path.is_symlink()) and (not path.is_file() or not path.read_text().startswith(MANAGED)):
                raise RuntimeError(f"Deployment-managed path contains custom configuration: {path}")
        self.dropin_dir_existed = self.dropin_dir.exists()
        if (self.support.exists() or self.support.is_symlink()) and (
                not self.support.is_file() or "# Hearth deployment protocol: 1" not in self.support.read_text()[:4096].splitlines()):
            raise RuntimeError("Deployment support path contains an unrecognized file")
        self.bundle.mkdir(mode=0o700)
        try:
            for index, path in enumerate([self.current, self.unit, self.dropin, self.environment, self.launcher, self.support]):
                prior = signature(path)
                backup = self.bundle / str(index)
                if prior != ("absent",):
                    shutil.copy2(path, backup, follow_symlinks=False)
                self.entries.append((path, backup, prior))
            for index, path in enumerate(self.unchanged):
                if path.is_file():
                    shutil.copy2(path, self.bundle / f"configuration-{index}")
            (self.bundle / "snapshot.json").write_text(json.dumps({
                "service": self.before, "release": self.old_identity, "port": self.old_port,
                "dropin_directory_existed": self.dropin_dir_existed,
                "paths": [{"path": str(path), "backup": str(backup), "kind": prior[0]} for path, backup, prior in self.entries],
                "configuration_sources": [{"path": str(path), "backup": str(self.bundle / f"configuration-{index}")}
                                          for index, path in enumerate(self.unchanged) if path.is_file()],
            }, indent=2) + "\n")
            self.evidence = InstallationEvidence.capture(
                self.before, self.old_identity, self.old_port, self.unchanged,
                [path for path, _, _ in self.entries])
            result_path = os.environ.get("HEARTH_ACTIVATION_RESULT")
            if result_path:
                durable_json(Path(result_path).with_name("activation-before.json"), self.evidence.snapshot())
        except Exception:
            shutil.rmtree(self.bundle)
            raise

    def activate(self):
        self.mutated = True
        self.current.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.current.with_name("." + self.current.name + "." + uuid.uuid4().hex)
        try:
            temporary.symlink_to(self.release)
            os.replace(temporary, self.current)
        finally:
            temporary.unlink(missing_ok=True)
        if self.first:
            self.unit.parent.mkdir(parents=True, exist_ok=True)
            atomic_text(self.unit, f"""[Unit]
Description=Hearth dashboard web server
After=network-online.target
[Service]
Type=simple
WorkingDirectory={self.current}
Environment=HEARTH_MODE=live HEARTH_AGENT_MODE=local HEARTH_BIND=127.0.0.1
Environment=HEARTH_STATE_DIR={self.state_dir} HEARTH_CONFIG_DIR={self.config} PORT={os.environ.get('PORT', '4173')}
EnvironmentFile=-{self.config}/hearth.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
""")
        self.dropin_dir.mkdir(exist_ok=True)
        atomic_text(self.environment, MANAGED + f"HEARTH_RELEASE={self.commit}\nHEARTH_AGENT={self.current}/pi/dashboard/dashboard_agent.py\n")
        atomic_text(self.dropin, MANAGED + f"[Service]\nWorkingDirectory={self.current}\nEnvironmentFile={self.environment}\n")
        systemctl("daemon-reload")
        environment = self.evidence.verify_candidate(self.current, self.commit, self.environment)
        if self.first:
            systemctl("enable", SERVICE)
        systemctl("restart", SERVICE)
        await_health(environment.get("PORT", "4173"), self.commit)
        if not self.first and self.before["ActiveState"] == "inactive":
            systemctl("stop", SERVICE)
        atomic_copy(self.release / "pi/dashboard/deploy_protocol.py", self.support)
        temporary = self.launcher.with_name(".deploy-launcher." + uuid.uuid4().hex)
        try:
            run("install", "-m", "755", str(self.release / "pi/dashboard/deploy-from-git.sh"), str(temporary))
            os.replace(temporary, self.launcher)
        finally:
            temporary.unlink(missing_ok=True)
        self.evidence.verify_activation()

    def recover(self):
        errors = []
        restored = []

        def attempt(label, action):
            try:
                action()
                restored.append(label)
                return True
            except Exception as error:
                errors.append(f"{label}: {error}")
                return False

        # Stop the candidate before changing the files that a restart will use.
        attempt("stop candidate", lambda: systemctl("stop", SERVICE) if service_state()["LoadState"] != "not-found" else None)
        if self.first:
            attempt("remove first-install autostart", lambda: systemctl("disable", SERVICE))
        configuration_restored = True
        for path, backup, prior in self.entries:
            if path == self.unit and not self.first:
                continue
            def restore(path=path, backup=backup, prior=prior):
                if prior == ("absent",):
                    path.unlink(missing_ok=True)
                else:
                    atomic_copy(backup, path)
                if signature(path) != prior:
                    raise RuntimeError("restored file does not match its backup")
            configuration_restored = attempt(f"restore {path}", restore) and configuration_restored
        if not self.dropin_dir_existed:
            attempt("remove introduced drop-in directory", lambda: self.dropin_dir.rmdir())
        configuration_restored = attempt("reload restored configuration", lambda: systemctl("daemon-reload")) and configuration_restored
        configuration_restored = attempt("verify operator configuration", self.evidence.verify_unchanged) and configuration_restored
        if not self.first and self.before["ActiveState"] == "active":
            if configuration_restored:
                def restart_previous():
                    # systemd may collect a stopped unit after reload. In that
                    # case reset-failed reports "not loaded" and the following
                    # restart loads a fresh unit. Restart + health are decisive.
                    systemctl("reset-failed", SERVICE, check=False)
                    systemctl("restart", SERVICE)
                attempt("restart previous service", restart_previous)
                attempt("verify previous release", lambda: await_health(self.old_port, self.old_identity))
            else:
                errors.append("previous service was not restarted because its configuration could not be restored")
        attempt("verify recovery", self.evidence.verify_rollback)
        return errors, restored

    def discard_completed(self, outcome):
        # Once verification commits the outcome, interruption must not begin a
        # rollback with partially removed backups. A leftover completed bundle
        # can be discarded safely by the next invocation.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        (self.bundle / "completed").write_text(outcome + "\n")
        try:
            shutil.rmtree(self.bundle)
        except OSError:
            print(f"Warning: completed recovery material remains at {self.bundle}", file=sys.stderr)

    def execute(self):
        self.prepare()
        try:
            self.activate()
            self.discard_completed("activated")
            self.outcome = "activated"
        except Exception as error:
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            errors, restored = self.recover() if self.mutated else ([], [])
            report = f"Activation failed: {error}\n"
            if errors:
                report += "Restored:\n" + "\n".join(restored) + "\nRecovery incomplete:\n" + "\n".join(errors) + f"\nRecovery files retained at {self.bundle}\n"
                try:
                    (self.bundle / "failure.txt").write_text(report)
                except OSError as diagnostic_error:
                    report += f"Could not save failure diagnostics: {diagnostic_error}\n"
            else:
                report += "Previous installation restored and verified.\n"
                self.discard_completed("rolled-back")
                self.outcome = "rolled-back"
            raise RuntimeError(report) from error
        status = "running" if self.first or self.before["ActiveState"] == "active" else "selected; service returned to inactive"
        print(f"Hearth release {self.commit} {status} from {self.release}.")


def cancelled(_signum, _frame):
    raise RuntimeError("Deployment cancelled")


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    activation = Activation(*sys.argv[1:])
    status = 0
    try:
        activation.execute()
    except Exception as error:
        print(str(error), file=sys.stderr)
        status = 1
    # Receipt persistence is outside the activation/recovery transaction.
    result_path = os.environ.get("HEARTH_ACTIVATION_RESULT")
    if result_path and (activation.outcome or not activation.mutated):
        try:
            durable_json(Path(result_path), {"outcome": activation.outcome or "failed-before-activation"})
        except Exception as error:
            print(f"Completion could not be recorded: {error}", file=sys.stderr)
            status = 1
    sys.exit(status)
