#!/usr/bin/env python3
# Hearth deployment protocol: 1
"""Private deployment receipts and transport; activation stays in deploy_activation.py."""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

PROTOCOL = 1
MARKER = "# Hearth deployment protocol: 1"
TERMINAL = {"activated", "rolled-back", "failed-before-activation", "reconciled"}
STOP = False
SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
               "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"]


def request_stop(_signal, _frame):
    global STOP
    STOP = True


def git(*args, cwd=None):
    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1", GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(["git", "--no-replace-objects", *map(str, args)], cwd=cwd,
                            env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Git operation failed")
    return result.stdout.strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else stream_digest(stream)


def stream_digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_directory(path):
    if path.exists():
        if not path.is_dir():
            raise RuntimeError("Expected a directory: " + str(path))
        return
    durable_directory(path.parent)
    path.mkdir(mode=0o700)
    sync_directory(path.parent)


def durable_json(path, value):
    durable_directory(path.parent)
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    try:
        with temporary.open("x", encoding="utf8") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def require_id(value):
    if not re.fullmatch(r"[a-f0-9]{32}", value):
        raise RuntimeError("Invalid deployment attempt ID")
    return value


def require_commit(value):
    if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", value):
        raise RuntimeError("Expected a full commit ID")
    return value


def compatible(directory):
    for name in ("deploy-from-git.sh", "deploy_protocol.py", "deploy_activation.py"):
        path = directory / name
        if not path.is_file() or MARKER not in path.read_text()[:4096].splitlines():
            raise RuntimeError("Unsupported deployment protocol in " + str(path))


def verify_legacy_installation(module, evidence_path, outcome, current, release):
    """Retain the coordinator's protocol-1 checks for releases without a verifier.

    Do not fall back here after a newer verifier fails: rejection is authoritative.
    """
    before = json.loads(evidence_path.read_text())
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
        if not current.is_symlink() or current.resolve() != release.resolve():
            raise RuntimeError("Selected release does not match the proposed outcome")
        identity = release.name
        environment, _ = module.effective_environment(state)
        if environment.get("HEARTH_RELEASE") != identity or environment.get("HEARTH_AGENT") != str(current / "pi/dashboard/dashboard_agent.py"):
            raise RuntimeError("Effective release settings do not match the proposed outcome")
        port = environment.get("PORT", "4173")
    else:
        identity, port = before["identity"], before["port"]
    if active == "active" and module.health(port) != identity:
        raise RuntimeError("Running release does not match the proposed outcome")


class Installation:
    def __init__(self):
        self.base = Path(os.environ.get("HEARTH_BASE_DIR", str(Path.home() / "Code/dashboard")))
        self.state = Path(os.environ.get("HEARTH_STATE_DIR", str(self.base / "state")))
        self.attempts = self.state / "deploy-attempts"
        self.releases = Path(os.environ.get("HEARTH_RELEASES_DIR", str(self.base / "releases")))
        self.config = Path(os.environ.get("HEARTH_CONFIG_DIR", str(self.base / "config")))
        self.current = Path(os.environ.get("HEARTH_CURRENT_LINK", str(self.base / "current")))
        for path in (self.base, self.state, self.releases, self.config, self.current):
            if not path.is_absolute() or re.search(r"[\s\\\"'%]", str(path)):
                raise RuntimeError("Deployment paths must be absolute without whitespace or shell metacharacters")

    @contextlib.contextmanager
    def locked(self, own=None, resolving=False):
        durable_directory(self.state)
        with (self.state / "deploy.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError("Another Hearth deployment is already running") from error
            recovery = self.state / "deploy-recovery"
            if recovery.is_symlink() or (recovery.exists() and not (recovery / "completed").is_file()):
                raise RuntimeError("Unresolved deployment recovery at " + str(recovery))
            if self.attempts.is_symlink():
                raise RuntimeError("Unsafe deployment receipt directory")
            for directory in self.attempts.iterdir() if self.attempts.exists() else []:
                if directory.is_symlink() or not directory.is_dir():
                    raise RuntimeError("Invalid deployment evidence at " + str(directory))
                if ((directory / "unresolved.json").exists() or (directory / "unresolved.json").is_symlink()) and not (resolving and directory.name == own):
                    raise RuntimeError("Unresolved deployment outcome: " + str(directory))
                value = self.read(directory.name)
                if directory.name != own and value["outcome"] not in TERMINAL:
                    raise RuntimeError("Unresolved deployment outcome: " + str(directory))
            self.lock_fd = lock.fileno()
            yield

    def directory(self, attempt):
        path = self.attempts / require_id(attempt)
        if path.is_symlink():
            raise RuntimeError("Unsafe attempt directory")
        return path

    def read(self, attempt):
        directory = self.directory(attempt)
        path = directory / "receipt.json"
        if path.is_symlink():
            raise RuntimeError("Unsafe receipt")
        value = json.loads(path.read_text())
        if (not isinstance(value, dict) or value.get("protocol") != PROTOCOL or value.get("id") != attempt
                or value.get("outcome") not in TERMINAL | {"unresolved", "ready"}
                or value.get("phase") not in {"preparation", "transfer", "verification", "staging", "validation", "activation", "complete"}
                or value.get("transport") not in {"bundle", "fetch"}
                or (value.get("commit") is not None and not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", str(value["commit"])))):
            raise RuntimeError("Invalid deployment receipt at " + str(path))
        return value

    def save(self, receipt, **updates):
        receipt.update(updates)
        durable_json(self.directory(receipt["id"]) / "receipt.json", receipt)

    def create(self, attempt, commit, transport, checksum=None):
        durable_directory(self.attempts)
        self.directory(attempt).mkdir(mode=0o700)
        sync_directory(self.attempts)
        receipt = {"protocol": PROTOCOL, "id": attempt, "commit": commit, "transport": transport,
                   "checksum": checksum, "phase": "preparation", "outcome": "unresolved"}
        self.save(receipt)
        return receipt

    def clean(self, receipt):
        directory = self.directory(receipt["id"])
        for name in ("bundle", "bundle.part", "repository", "staging", "cancel"):
            path = directory / name
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        if receipt.get("commit"):
            staging = self.staging_path(receipt)
            if staging.is_dir() and not staging.is_symlink():
                shutil.rmtree(staging)
        log = directory / "diagnostics.log"
        if log.is_file() and log.stat().st_size > 65536:
            with log.open("rb") as stream:
                stream.seek(-65536, 2)
                tail = stream.read()
            log.write_bytes(tail)

    def staging_path(self, receipt):
        return self.releases / ("." + require_commit(receipt["commit"]) + ".tmp." + receipt["id"])

    def run_command(self, receipt, args, cwd=None, env=None, activation=False):
        directory = self.directory(receipt["id"])
        if STOP or (directory / "cancel").exists():
            raise RuntimeError("Deployment cancelled")
        with (directory / "diagnostics.log").open("ab") as log:
            child = subprocess.Popen(list(map(str, args)), cwd=cwd, env=env,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, start_new_session=True,
                                     pass_fds=(self.lock_fd,) if activation else ())
            if activation:
                self.activation_started = True
            sent = False
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            try:
                while selector.get_map() or child.poll() is None:
                    if not sent and (STOP or (directory / "cancel").exists()):
                        sent = True
                        # The activation process handles TERM and owns recovery. Do not kill its group.
                        if activation:
                            child.send_signal(signal.SIGTERM)
                        else:
                            os.killpg(child.pid, signal.SIGTERM)
                    for key, _ in selector.select(0.1):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        log.write(chunk)
                        log.flush()
                        try:
                            sys.stdout.buffer.write(chunk)
                            sys.stdout.buffer.flush()
                        except BrokenPipeError:
                            # The receipt remains authoritative even if SSH stops reading.
                            pass
                code = child.wait()
            finally:
                selector.close()
                child.stdout.close()
            if code and not activation:
                raise RuntimeError("Deployment command failed (exit " + str(code) + ")")
            if sent and not activation:
                raise RuntimeError("Deployment cancelled")
            return code

    def run_validation(self, receipt, step, args, cwd, env):
        self.save(receipt, phase="validation", validationStep=step)
        heading = "Validation: " + step + "\n"
        print(heading, end="", flush=True)
        with (self.directory(receipt["id"]) / "diagnostics.log").open("ab") as log:
            log.write(heading.encode())
        try:
            self.run_command(receipt, args, cwd=cwd, env=env)
        except (OSError, RuntimeError) as error:
            raise RuntimeError("Validation failed during " + step + ": " + str(error)) from error

    def receive(self, attempt, commit, checksum, size):
        require_commit(commit)
        if not re.fullmatch(r"[a-f0-9]{64}", checksum) or size < 1:
            raise RuntimeError("Invalid bundle metadata")
        with self.locked():
            receipt = self.create(attempt, commit, "bundle", checksum)
            directory = self.directory(attempt)
            try:
                self.save(receipt, phase="transfer")
                remaining = size
                with (directory / "bundle.part").open("xb") as stream:
                    while remaining:
                        chunk = sys.stdin.buffer.read(min(1024 * 1024, remaining))
                        if not chunk or STOP or (directory / "cancel").exists():
                            raise RuntimeError("Interrupted bundle transfer")
                        stream.write(chunk)
                        remaining -= len(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
                if sys.stdin.buffer.read(1) or digest(directory / "bundle.part") != checksum:
                    raise RuntimeError("Bundle checksum or size mismatch")
                os.replace(directory / "bundle.part", directory / "bundle")
                self.save(receipt, phase="verification", outcome="ready")
            except Exception as error:
                self.save(receipt, outcome="failed-before-activation", error=str(error))
                self.clean(receipt)
                raise

    def deploy(self, revision=None, attempt=None, fetch_attempt=None):
        with self.locked(own=attempt):
            receipt = self.read(attempt) if attempt else self.create(fetch_attempt or uuid.uuid4().hex, None, "fetch")
            directory = self.directory(receipt["id"])
            if attempt and (receipt["outcome"] != "ready" or receipt["phase"] != "verification"):
                raise RuntimeError("Attempt is not ready for deployment")
            self.activation_started = False
            try:
                if attempt:
                    repository = directory / "repository"
                    self.save(receipt, phase="verification", outcome="unresolved")
                    if digest(directory / "bundle") != receipt["checksum"]:
                        raise RuntimeError("Bundle checksum mismatch")
                    git("init", "--bare", "-q", repository)
                    git("-C", repository, "bundle", "verify", directory / "bundle")
                    heads = git("bundle", "list-heads", directory / "bundle").splitlines()
                    if len(heads) != 1 or heads[0].split()[0] != receipt["commit"]:
                        raise RuntimeError("Bundle does not identify exactly the requested commit")
                    git("-C", repository, "fetch", str(directory / "bundle"), heads[0].split()[1])
                    commit = git("-C", repository, "rev-parse", "--verify", "FETCH_HEAD^{commit}")
                    if commit != receipt["commit"]:
                        raise RuntimeError("Bundle commit mismatch")
                    git("-C", repository, "fsck", "--full", "--no-reflogs", commit)
                else:
                    repository = Path(os.environ.get("HEARTH_REPOSITORY_DIR", str(self.base / "repository")))
                    origin = os.environ.get("HEARTH_REPOSITORY_URL", "https://github.com/rrwwee/hearth-public.git")
                    if not (repository / ".git").is_dir():
                        if repository.exists():
                            raise RuntimeError("Repository cache exists but is not a Git repository")
                        self.run_command(receipt, ["git", "clone", "--no-checkout", origin, repository])
                    elif git("-C", repository, "remote", "get-url", "origin") != origin:
                        raise RuntimeError("Repository origin does not match HEARTH_REPOSITORY_URL")
                    self.run_command(receipt, ["git", "-C", repository, "fetch", "--prune", "origin"])
                    commit = git("-C", repository, "rev-parse", "--verify", revision + "^{commit}")
                    self.save(receipt, commit=commit)
                require_commit(commit)
                print("Hearth attempt " + receipt["id"] + ": staging " + commit, flush=True)
                self.save(receipt, phase="staging")
                self.releases.mkdir(parents=True, exist_ok=True)
                staging = self.staging_path(receipt)
                staging.mkdir()
                archive = subprocess.Popen(["git", "--no-replace-objects", "-C", str(repository), "archive", commit], stdout=subprocess.PIPE)
                try:
                    extracted = subprocess.run(["tar", "-x", "-C", str(staging)], stdin=archive.stdout)
                    archive.stdout.close()
                    if archive.wait() or extracted.returncode:
                        raise RuntimeError("Cannot extract committed release")
                finally:
                    if archive.poll() is None:
                        archive.terminate()
                        archive.wait()
                compatible(staging / "pi/dashboard")
                (staging / ".hearth-release").write_text(commit + "\n")
                private = Path(os.environ.get("HEARTH_PRIVATE_DIR", str(self.base / "private"))) / "public/background.mp4"
                if private.is_file():
                    (staging / "public/background.mp4").symlink_to(private)
                self.config.mkdir(parents=True, exist_ok=True)
                environment = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1", GIT_TERMINAL_PROMPT="0",
                    PYTHONDONTWRITEBYTECODE="1", HEARTH_BASE_DIR=str(self.base), HEARTH_CURRENT_LINK=str(self.current),
                    HEARTH_STATE_DIR=str(self.state), HEARTH_CONFIG_DIR=str(self.config),
                    HEARTH_SYSTEMD_USER_DIR=os.environ.get("HEARTH_SYSTEMD_USER_DIR", str(Path.home() / ".config/systemd/user")))
                # Candidate tests own their fixtures. Never give them target
                # installation paths or repository overrides from a Git hook.
                test_environment = {key: value for key, value in os.environ.items()
                                    if not key.startswith(("HEARTH_", "GIT_")) and key != "PORT"}
                test_environment.update(GIT_NO_REPLACE_OBJECTS="1", GIT_TERMINAL_PROMPT="0",
                                        PYTHONDONTWRITEBYTECODE="1")
                self.run_validation(receipt, "syntax", ["npm", "run", "check:syntax"], staging, test_environment)
                self.run_validation(receipt, "fixtures", ["npm", "test"], staging, test_environment)
                validation = dict(environment, HEARTH_MODE="live", HEARTH_VALIDATE_ONLY="1", HEARTH_AGENT_MODE="local",
                                  HEARTH_AGENT=str(staging / "pi/dashboard/dashboard_agent.py"))
                self.run_validation(receipt, "live-configuration", ["node", "server.js"], staging, validation)
                self.releases.mkdir(parents=True, exist_ok=True)
                release = self.releases / commit
                if release.exists():
                    # Existing releases must still match committed content; never silently reuse edited code.
                    result = subprocess.run(["diff", "-qr", str(staging), str(release)], capture_output=True)
                    if result.returncode:
                        raise RuntimeError("Existing release differs from the verified committed content")
                    shutil.rmtree(staging)
                else:
                    os.replace(staging, release)
                if STOP or (directory / "cancel").exists():
                    raise RuntimeError("Deployment cancelled")
                # Persist before invoking anything which may select a release.
                self.save(receipt, phase="activation", outcome="unresolved")
                durable_json(directory / "unresolved.json", {"id": receipt["id"], "commit": commit})
                result_path = directory / "activation-result.json"
                environment["HEARTH_ACTIVATION_RESULT"] = str(result_path)
                environment["HEARTH_DEPLOY_LOCK_FD"] = str(self.lock_fd)
                self.run_command(receipt, [sys.executable, release / "pi/dashboard/deploy_activation.py", release, commit],
                                 env=environment, activation=True)
                result = json.loads(result_path.read_text())
                if result.get("outcome") not in {"activated", "rolled-back", "failed-before-activation"}:
                    raise RuntimeError("Activation did not establish a completed outcome")
                # Outside activation: failure to save this does not initiate another rollback.
                self.save(receipt, phase="complete", outcome=result["outcome"])
                (directory / "unresolved.json").unlink()
                self.clean(receipt)
                return 0 if result["outcome"] == "activated" else 1
            except Exception as error:
                if not self.activation_started:
                    self.save(receipt, outcome="failed-before-activation", error=str(error))
                    (directory / "unresolved.json").unlink(missing_ok=True)
                    self.clean(receipt)
                else:
                    print("Completion could not be recorded; outcome unresolved. Inspect " + str(directory), file=sys.stderr)
                raise

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
                release = self.releases / require_commit(receipt["commit"])
                helper = release / "pi/dashboard/deploy_activation.py"
                spec = importlib.util.spec_from_file_location("hearth_activation", helper)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                evidence_path = directory / "activation-before.json"
                verifier = getattr(module, "verify_installation_outcome", None)
                if verifier is None:
                    verify_legacy_installation(module, evidence_path, outcome, self.current, release)
                else:
                    verifier(evidence_path, outcome, self.current, release)
            self.save(receipt, phase="complete", outcome="reconciled", reconciled_outcome=outcome)
            (directory / "unresolved.json").unlink(missing_ok=True)
            self.clean(receipt)
            print("Reconciled " + attempt + ": " + outcome)
        return 0


def remote(target, base, *args, **kwargs):
    command = shlex.join(["env", "HEARTH_BASE_DIR=" + base, "bash", base + "/deploy-from-git.sh", *map(str, args)])
    return subprocess.run(["ssh", *SSH_OPTIONS, target, command], **kwargs)


def wait_for_deployment(target, base, attempt, *action):
    command = shlex.join(["env", "HEARTH_BASE_DIR=" + base, "bash", base + "/deploy-from-git.sh", *map(str, action)])
    child = subprocess.Popen(["ssh", *SSH_OPTIONS, target, command], start_new_session=True)
    cancelled = False
    next_cancel = 0
    while child.poll() is None:
        if STOP and not cancelled and time.monotonic() >= next_cancel:
            try:
                requested = remote(target, base, "--cancel", attempt, timeout=10, capture_output=True)
                cancelled = requested.returncode == 0
            except subprocess.TimeoutExpired:
                pass
            next_cancel = time.monotonic() + 1
        time.sleep(0.1)
    if child.returncode:
        print("Deployment did not report success; outcome may be unknown. Inspect attempt " + attempt + " before retrying.", file=sys.stderr)
    return child.returncode


def client(argv):
    parser = argparse.ArgumentParser(description="Deploy a committed Hearth release")
    parser.add_argument("--bundle", action="store_true")
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("target", nargs="?", default=os.environ.get("HEARTH_DEPLOY_TARGET"))
    parser.add_argument("revision", nargs="?")
    args = parser.parse_args(argv)
    base = os.environ.get("HEARTH_DEPLOY_BASE", "")
    if (not args.target or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._@:-]*", args.target)
            or not re.fullmatch(r"/[A-Za-z0-9._/-]+", base)):
        parser.error("A valid SSH target and absolute HEARTH_DEPLOY_BASE are required")
    if args.bundle and not args.revision:
        parser.error("Bundle deployments require an explicit revision")
    # Read the declaration without executing a potentially legacy deployment launcher.
    probe = "from pathlib import Path; import sys; p=Path(sys.argv[1]); sys.exit(0 if p.is_file() and " + repr(MARKER) + " in p.read_text()[:4096].splitlines() else 1)"
    checked = subprocess.run(["ssh", *SSH_OPTIONS, args.target,
                              shlex.join(["python3", "-c", probe, base + "/deploy-from-git.sh"])])
    if checked.returncode:
        raise RuntimeError("Unsupported installed launcher. Use the documented explicit first-upgrade procedure; no deployment started.")
    capability = remote(args.target, base, "--capabilities", capture_output=True, text=True)
    if capability.returncode or json.loads(capability.stdout).get("protocol") != PROTOCOL:
        raise RuntimeError("Unsupported installed deployment support. Use the explicit first-upgrade procedure.")
    if not args.bundle:
        attempt = uuid.uuid4().hex
        print("Hearth attempt " + attempt + ": direct fetch", flush=True)
        return wait_for_deployment(args.target, base, attempt, "--deploy-fetch", attempt, args.revision or "origin/main")
    source = args.source.resolve()
    if git("-C", source, "rev-parse", "--is-shallow-repository") != "false":
        raise RuntimeError("Bundle deployment requires complete source history")
    partial = subprocess.run(["git", "-C", str(source), "config", "--get-regexp", r"remote\..*\.promisor"],
                             capture_output=True, text=True)
    if partial.returncode == 0:
        raise RuntimeError("Bundle deployment requires complete, non-partial source history")
    commit = require_commit(git("-C", source, "rev-parse", "--verify", "--end-of-options", args.revision + "^{commit}"))
    status = git("-C", source, "status", "--porcelain")
    print("Source " + str(source) + ": " + commit + (" (dirty; edits excluded)" if status else " (clean)"), flush=True)
    attempt = uuid.uuid4().hex
    ref = "refs/hearth/deploy/" + attempt
    git("-C", source, "update-ref", ref, commit, "0" * len(commit))
    try:
        with tempfile.TemporaryDirectory(prefix="hearth-deploy-") as temporary:
            bundle = Path(temporary) / "release.bundle"
            git("-C", source, "bundle", "create", bundle, ref)
            checksum = digest(bundle)
            print("Hearth attempt " + attempt + ": transfer", flush=True)
            with bundle.open("rb") as stream:
                sent = remote(args.target, base, "--receive", attempt, commit, checksum, bundle.stat().st_size, stdin=stream)
            if sent.returncode:
                raise RuntimeError("Transfer failed; inspect remote receipt for attempt " + attempt)
            return wait_for_deployment(args.target, base, attempt, "--deploy-bundle", attempt)
    finally:
        git("-C", source, "update-ref", "-d", ref, commit)


def main(argv):
    os.umask(0o077)
    for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(name, request_stop)
    if argv and argv[0] == "client":
        return client(argv[1:])
    if argv == ["--capabilities"]:
        print(json.dumps({"protocol": PROTOCOL}))
        return 0
    installation = Installation()
    if argv and argv[0] == "--receive" and len(argv) == 5:
        installation.receive(argv[1], argv[2], argv[3], int(argv[4]))
        return 0
    if argv and argv[0] == "--deploy-bundle" and len(argv) == 2:
        return installation.deploy(attempt=require_id(argv[1]))
    if argv and argv[0] == "--deploy-fetch" and len(argv) == 3:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", argv[2]):
            raise RuntimeError("Invalid Git revision")
        return installation.deploy(revision=argv[2], fetch_attempt=require_id(argv[1]))
    if argv and argv[0] == "--status" and len(argv) == 2:
        print(json.dumps(installation.read(argv[1]), indent=2))
        return 0
    if argv and argv[0] == "--cancel" and len(argv) == 2:
        receipt = installation.read(argv[1])
        if receipt["outcome"] not in TERMINAL:
            (installation.directory(argv[1]) / "cancel").touch(mode=0o600, exist_ok=True)
        return 0
    if argv and argv[0] == "--reconcile" and len(argv) == 3:
        return installation.reconcile(require_id(argv[1]), argv[2])
    if len(argv) > 1 or (argv and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", argv[0])):
        raise RuntimeError("Invalid deployment command or revision")
    return installation.deploy(revision=argv[0] if argv else "origin/main")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
