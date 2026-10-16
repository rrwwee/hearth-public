#!/usr/bin/env python3
"""Development prerequisite checks. Only OS boundaries are replaceable in tests."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time


class System:
    def run(self, args, *, cwd, timeout):
        # Probe the environment the real tools will use, including runtime
        # startup settings and authentication configuration. Only Git's
        # repository-routing overrides conflict with inspecting this checkout.
        env = os.environ.copy()
        if args[0] == "git":
            for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
                         "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"):
                env.pop(name, None)
            # The child has no stdin or controlling terminal. Disable standard
            # askpass/credential-manager prompts without replacing SSH config.
            env.update(GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="false",
                       GCM_INTERACTIVE="never", SSH_ASKPASS_REQUIRE="never")
        deadline = time.monotonic() + timeout
        cleanup_budget = min(0.1, timeout / 10)
        process = subprocess.Popen(args, cwd=cwd, env=env, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=max(0, deadline - time.monotonic() - cleanup_budget))
        except BaseException:
            # Kill the whole probe, including credential helpers or SSH children.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # An escaped descendant may still own the write ends. Never wait
            # for EOF after termination; close our reads and bound direct-child
            # reaping by the remaining deadline too.
            process.stdout.close()
            process.stderr.close()
            try:
                process.wait(timeout=max(0, min(cleanup_budget, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
            raise
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)

    def loopback(self, timeout):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.settimeout(timeout)
            server.bind(("127.0.0.1", 0))
            server.listen(1)


def version(text):
    match = re.fullmatch(r"v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", text.strip())
    if not match:
        raise ValueError(f"Unrecognized stable version: {text.strip()}")
    return tuple(int(part or 0) for part in match.groups())


def supports(actual, requirement):
    """Evaluate the >= and caret ranges used by maintained Node manifests.

    Unknown syntax fails explicitly instead of silently assuming compatibility.
    """
    alternatives = []
    for part in requirement.split("||"):
        match = re.fullmatch(r"\s*(>=|\^)(\d+(?:\.\d+){0,2})\s*", part)
        if not match:
            raise ValueError(f"Unsupported Node engine expression: {requirement}")
        operator, text = match.groups()
        minimum = version(text)
        maximum = (minimum[0] + 1, 0, 0) if minimum[0] else ((0, minimum[1] + 1, 0) if minimum[1] else (0, 0, minimum[2] + 1))
        alternatives.append(actual >= minimum and (operator == ">=" or actual < maximum))
    return any(alternatives)


class Probe:
    def __init__(self, root, system, clock):
        self.root, self.system, self.clock = root, system, clock
        self.started = clock()
        self.deadline = self.started + 30
        self.results = []
        self.check_deadline = self.deadline

    def command(self, args, limit=5):
        timeout = min(limit, self.check_deadline - self.clock(), self.deadline - self.clock())
        if timeout <= 0:
            raise subprocess.TimeoutExpired(args, 0)
        return self.system.run(args, cwd=self.root, timeout=timeout)

    def add(self, name, status, detail, category="prerequisite"):
        self.results.append({"check": name, "status": status, "category": category, "detail": detail})

    def check(self, name, action, *, limit=5, category="prerequisite"):
        if self.clock() >= self.deadline:
            self.add(name, "unknown", "Overall 30-second deadline exhausted; this check did not finish.", category)
            return
        self.check_deadline = min(self.deadline, self.clock() + limit)
        try:
            status, detail = action()
        except subprocess.TimeoutExpired:
            status = "unknown" if category == "freshness" or self.clock() >= self.deadline else "fail"
            detail = "Probe timed out; rerun in an environment where this prerequisite responds."
        except FileNotFoundError as error:
            status, detail = "fail", f"Missing prerequisite: {error.filename}. See README.md#verification for setup."
        except PermissionError:
            category = "execution-permission"
            status, detail = "fail", "Permission denied. Request the necessary execution permission, then rerun this command."
        except (OSError, ValueError, KeyError, TypeError) as error:
            status, detail = "fail", f"Cannot check prerequisite: {error}. See README.md#verification."
        self.add(name, status, detail, category)


def read_json(path):
    return json.loads(path.read_text())


def run_preflight(root, *, mode="implementation", base="origin/main", revision=None,
                  system=None, clock=time.monotonic, systemd=False):
    root = Path(root).resolve()
    probe = Probe(root, system or System(), clock)

    def node():
        result = probe.command(["node", "--version"])
        if result.returncode:
            return "fail", "Node could not start. See README.md#verification."
        actual = version(result.stdout)
        runtime = read_json(root / "package.json")["engines"]["node"]
        lint = read_json(root / "package-lock.json")["packages"]["node_modules/eslint"]["engines"]["node"]
        status = "pass" if supports(actual, runtime) and supports(actual, lint) else "fail"
        npm = probe.command(["npm", "--version"])
        if npm.returncode or not npm.stdout.strip():
            return "fail", "npm cannot start; it is required to run release verification. See README.md#verification."
        return status, f"Node {result.stdout.strip()}; runtime requires {runtime}; pinned ESLint requires {lint}. See README.md#verification."

    def python():
        result = probe.command(["python3", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"])
        required = (root / ".python-version").read_text().strip()
        if result.returncode:
            return "fail", "Python could not start. See README.md#verification."
        return ("pass" if version(result.stdout) >= version(required) else "fail",
                f"Python {result.stdout.strip()}; development requires {required}+. See README.md#verification.")

    def npm_tools():
        declared = read_json(root / "package.json")["devDependencies"]
        locked = read_json(root / "package-lock.json")["packages"]
        for name, pin in declared.items():
            installed = read_json(root / "node_modules" / name / "package.json")["version"]
            if installed != pin or locked[f"node_modules/{name}"]["version"] != pin:
                return "fail", f"{name} does not match pin {pin}. Run npm ci; see README.md#verification."
        result = probe.command(["node", str(root / "node_modules/eslint/bin/eslint.js"), "--version"])
        pin = declared["eslint"]
        if result.returncode or result.stdout.strip() != f"v{pin}":
            return "fail", "Pinned ESLint cannot start or reports a different version. Run npm ci."
        return "pass", "Installed npm development packages match their pins; ESLint starts."

    def python_tools():
        pins = dict(re.findall(r"^(ruff|shellcheck-py)==([^\s]+)$", (root / "requirements-lint.txt").read_text(), re.M))
        if set(pins) != {"ruff", "shellcheck-py"}:
            raise ValueError("requirements-lint.txt must pin Ruff and shellcheck-py")
        metadata = probe.command([str(root / ".venv-lint/bin/python"), "-I", "-c",
                                  "import importlib.metadata as m, json; print(json.dumps({n:m.version(n) for n in ('ruff','shellcheck-py')}))"])
        if metadata.returncode or json.loads(metadata.stdout) != pins:
            return "fail", "Python lint packages are missing or differ from requirements-lint.txt. Recreate .venv-lint; see README.md#verification."
        # shellcheck-py uses the first three components for the upstream binary;
        # an optional fourth component is the packaging revision (see its setup.cfg).
        shellcheck_pin = re.fullmatch(r"(\d+\.\d+\.\d+)(?:\.\d+)?", pins["shellcheck-py"])
        if not shellcheck_pin:
            raise ValueError("Unrecognized shellcheck-py pin; verify its upstream version convention")
        expected = {"ruff": f"ruff {pins['ruff']}", "shellcheck": f"version: {shellcheck_pin[1]}"}
        for name in ("ruff", "shellcheck"):
            result = probe.command([str(root / f".venv-lint/bin/{name}"), "--version"])
            if result.returncode or expected[name] not in result.stdout.strip().splitlines():
                return "fail", f"{name} cannot start or reports a different version. Recreate .venv-lint."
        return "pass", "Ruff and shellcheck-py match their pins; both lint executables start."

    probe.check("node", node)
    probe.check("python", python)
    probe.check("npm-tools", npm_tools)
    probe.check("python-tools", python_tools)
    def loopback():
        probe.system.loopback(max(0.001, probe.check_deadline - clock()))
        return "pass", "Bound and closed an ephemeral 127.0.0.1 server."

    probe.check("loopback", loopback, category="execution-environment")
    checkout_head = None

    def checkout():
        nonlocal checkout_head
        if not (root / ".git").exists():
            return ("not-applicable" if mode == "local" else "unknown",
                    "No Git metadata in this source export; checkout revision cannot be established.")
        result = probe.command(["git", "rev-parse", "--show-toplevel"])
        if result.returncode or Path(result.stdout.strip()).resolve() != root:
            status = "not-applicable" if mode == "local" and not (root / ".git").exists() else "unknown"
            return status, "No usable Git metadata for this source root; checkout revision cannot be established."
        result = probe.command(["git", "rev-parse", "--verify", "HEAD^{commit}"])
        if result.returncode:
            return "unknown", "Cannot resolve checkout HEAD to a commit."
        checkout_head = result.stdout.strip()
        dirty = probe.command(["git", "status", "--porcelain", "--untracked-files=normal"])
        if dirty.returncode:
            return "unknown", f"HEAD={checkout_head}; cannot read uncommitted status."
        detail = f"HEAD={checkout_head}; {len(dirty.stdout.splitlines())} uncommitted entries (preserved)."
        if mode == "review":
            if not revision:
                return "fail", detail + " Review requires --revision naming the checked-out commit."
            requested = probe.command(["git", "rev-parse", "--verify", "--end-of-options", revision + "^{commit}"])
            if requested.returncode or requested.stdout.strip() != checkout_head:
                return "fail", detail + " Review revision must match HEAD; use a separate worktree at the intended revision."
        return "pass", detail

    def freshness():
        if not checkout_head:
            return "unknown", "Cannot establish base freshness without the checkout revision."
        remotes = probe.command(["git", "remote"])
        remote = next((name for name in sorted(remotes.stdout.splitlines(), key=len, reverse=True)
                       if base.startswith(name + "/")), None)
        if remotes.returncode or not remote:
            return "fail", "Base must name a configured remote branch, for example origin/main."
        branch = base[len(remote) + 1:]
        ref = "refs/heads/" + branch
        if probe.command(["git", "check-ref-format", ref]).returncode:
            return "fail", "Base is not a valid remote branch name."
        observed = probe.command(["git", "ls-remote", "--exit-code", "--", remote, ref], limit=15)
        if observed.returncode:
            return "unknown", f"Current evidence for {base} unavailable (git exit {observed.returncode}). Check connectivity, credentials and branch existence; cached refs are not evidence."
        lines = [line.split() for line in observed.stdout.splitlines()]
        matching = [parts[0] for parts in lines if len(parts) == 2 and parts[1] == ref]
        if len(matching) != 1 or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", matching[0]):
            return "unknown", f"Remote did not supply one unambiguous commit for {base}."
        target = matching[0]
        detail = f"{base}={target}; HEAD={checkout_head}; current remote evidence."
        if probe.command(["git", "cat-file", "-e", target + "^{commit}"]).returncode:
            # Fetch only the observed commit's objects; preserve refs and FETCH_HEAD.
            fetched = probe.command(["git", "fetch", "--no-tags", "--no-write-fetch-head", "--", remote, target], limit=15)
            if fetched.returncode:
                return "unknown", detail + " Cannot fetch objects to compare ancestry; check connectivity and credentials."
        counts = probe.command(["git", "rev-list", "--left-right", "--count", target + "..." + checkout_head])
        ancestor = probe.command(["git", "merge-base", "--is-ancestor", target, checkout_head])
        if counts.returncode or ancestor.returncode not in (0, 1):
            return "unknown", detail + " Cannot establish ancestry from available history."
        behind, ahead = counts.stdout.split()
        detail += f" behind={behind}, ahead={ahead}."
        if ancestor.returncode == 0:
            return "pass", detail
        shallow = probe.command(["git", "rev-parse", "--is-shallow-repository"])
        if shallow.returncode or shallow.stdout.strip() != "false":
            return "unknown", detail + " History is incomplete; obtain full history and rerun."
        return "fail", detail + " Incorporate the current target branch before continuing implementation; preflight does not modify your branch."

    probe.check("checkout", checkout, category="revision")
    if mode == "implementation":
        probe.check("freshness", freshness, limit=15, category="freshness")
    else:
        probe.add("freshness", "not-applicable", f"{mode} mode deliberately skips remote freshness; this does not establish implementation readiness for review.", "freshness")
    def docker():
        result = probe.command(["docker", "version", "--format", "{{.Server.Version}}"])
        if result.returncode or not result.stdout.strip():
            return "fail", "Docker's background service is unavailable. Start it and check access with docker version."
        return "pass", f"Docker service responds ({result.stdout.strip()}); systemd suites still need to run."

    if systemd:
        probe.check("docker", docker)
    else:
        probe.add("docker", "not-applicable", "Systemd verification was not selected.")
    statuses = [item["status"] for item in probe.results]
    return {"mode": mode, "base": base, "results": probe.results,
            "exit_code": 1 if "fail" in statuses else 2 if "unknown" in statuses else 0,
            "elapsed_seconds": round(clock() - probe.started, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("implementation", "review", "local"), default="implementation")
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--revision")
    parser.add_argument("--systemd", action="store_true")
    parser.add_argument("--json", action="store_true", help="Emit the same report as JSON")
    args = parser.parse_args()
    if args.mode == "review" and not args.revision:
        parser.error("review mode requires --revision matching HEAD")
    if args.mode != "review" and args.revision:
        parser.error("--revision is only used in review mode")
    report = run_preflight(Path(__file__).resolve().parent.parent, mode=args.mode, base=args.base,
                           revision=args.revision, systemd=args.systemd)
    if args.json:
        print(json.dumps(report))
    else:
        for result in report["results"]:
            print(f"{result['status'].upper():14} {result['check']}: {result['detail']}")
        print(f"Preflight: exit {report['exit_code']}, {report['elapsed_seconds']:.3f}s. No application tests ran.")
    return report["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
