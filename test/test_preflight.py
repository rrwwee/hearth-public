"""Preflight contract tests: controlled OS boundaries, never live services."""
import importlib.util
import json
import os
import signal
from pathlib import Path
import subprocess
import tempfile
import shutil
import sys
import time
import unittest
from unittest.mock import patch
from fixture_environment import fixture_environment

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "preflight.py"
spec = importlib.util.spec_from_file_location("hearth_preflight", SCRIPT)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class Environment:
    def __init__(self):
        self.responses = {}
        self.loopback_error = None

    def run(self, args, *, cwd, timeout):
        replacement = self.responses.get(args[0])
        if replacement is not None:
            if isinstance(replacement, Exception):
                raise replacement
            return subprocess.CompletedProcess(args, *replacement)
        if args == ["npm", "--version"]:
            return subprocess.CompletedProcess(args, 0, "11.4.2", "")
        if args == ["node", "--version"]:
            return subprocess.CompletedProcess(args, 0, "v24.4.1\n", "")
        if args[0] == "python3":
            return subprocess.CompletedProcess(args, 0, "3.12.4\n", "")
        if args[-1] == "--version":
            version = "v10.12.0" if "node" == args[0] else "ruff 0.17.0"
            if args[0].endswith("shellcheck"):
                version = "ShellCheck - shell script analysis tool\nversion: 0.11.0"
            return subprocess.CompletedProcess(args, 0, version, "")
        if args[0].endswith(".venv-lint/bin/python"):
            return subprocess.CompletedProcess(args, 0, '{"ruff":"0.17.0","shellcheck-py":"0.11.0.1"}', "")
        if args[:2] == ["git", "rev-parse"]:
            return subprocess.CompletedProcess(args, 128, "", "not a repository")
        raise AssertionError(f"Unexpected process: {args}")

    def loopback(self, timeout):
        if self.loopback_error:
            raise self.loopback_error
        return None


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hearth preflight ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.write(".python-version", "3.12\n")
        self.write("package.json", json.dumps({"engines": {"node": ">=20"}, "devDependencies": {"eslint": "10.12.0"}}))
        self.write("package-lock.json", json.dumps({"packages": {"node_modules/eslint": {
            "version": "10.12.0", "engines": {"node": "^20.19.0 || ^22.13.0 || >=24"},
        }}}))
        self.write("node_modules/eslint/package.json", '{"version":"10.12.0"}')
        self.write("requirements-lint.txt", "ruff==0.17.0\nshellcheck-py==0.11.0.1\n")
        self.environment = Environment()

    def write(self, path, contents):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents)

    def check(self, **options):
        return preflight.run_preflight(self.root, system=self.environment, **options)

    def test_local_export_checks_tools_and_loopback_without_remote_or_docker(self):
        report = self.check(mode="local")
        self.assertEqual(report["exit_code"], 0, report)
        results = {item["check"]: item for item in report["results"]}
        self.assertEqual(results["freshness"]["status"], "not-applicable")
        self.assertEqual(results["docker"]["status"], "not-applicable")
        self.assertEqual(results["loopback"]["status"], "pass")
        self.assertEqual(results["checkout"]["status"], "not-applicable")

    def test_missing_node_does_not_hide_other_checks(self):
        self.environment.responses["node"] = FileNotFoundError(2, "missing", "node")
        report = self.check(mode="local")
        self.assertEqual(report["exit_code"], 1)
        results = {item["check"]: item for item in report["results"]}
        self.assertIn("Missing prerequisite", results["node"]["detail"])
        self.assertEqual(results["loopback"]["status"], "pass")

    def test_unsupported_runtime_uses_declared_requirements(self):
        for executable, output in [("node", "v22.12.0"), ("python3", "3.11.9")]:
            with self.subTest(executable=executable):
                self.environment.responses = {executable: (0, output, "")}
                report = self.check(mode="local")
                result = next(item for item in report["results"] if item["check"] == ("python" if executable == "python3" else "node"))
                self.assertEqual(result["status"], "fail")
                self.assertIn("requires", result["detail"])

    def test_denied_loopback_is_an_execution_permission_failure(self):
        self.environment.loopback_error = PermissionError(1, "Operation not permitted")
        report = self.check(mode="local")
        result = next(item for item in report["results"] if item["check"] == "loopback")
        self.assertEqual(report["exit_code"], 1)
        self.assertEqual(result["category"], "execution-permission")
        self.assertIn("execution permission", result["detail"])

    def test_lint_pin_mismatch_and_failed_start_are_reported(self):
        self.write("node_modules/eslint/package.json", '{"version":"9.0.0"}')
        report = self.check(mode="local")
        self.assertEqual(report["exit_code"], 1)
        self.assertIn("does not match pin", str(report))
        self.write("node_modules/eslint/package.json", '{"version":"10.12.0"}')
        self.environment.responses["node"] = (1, "", "cannot load library")
        self.assertIn("cannot start", str(self.check(mode="local")))

    def test_systemd_selection_requires_a_responding_docker_service(self):
        self.environment.responses["docker"] = FileNotFoundError(2, "missing", "docker")
        report = self.check(mode="local", systemd=True)
        result = next(item for item in report["results"] if item["check"] == "docker")
        self.assertEqual(result["status"], "fail")
        self.environment.responses["docker"] = (1, "", "Cannot connect")
        self.assertEqual(self.check(mode="local", systemd=True)["exit_code"], 1)
        self.environment.responses["docker"] = (0, "27.0.3", "")
        self.assertEqual(self.check(mode="local", systemd=True)["exit_code"], 0)

    def git(self, *args):
        result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", str(self.root), *args], capture_output=True, text=True, check=True, env=fixture_environment())
        return result.stdout.strip()

    def repository(self):
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")
        remote = self.root.parent / (self.root.name + "-origin.git")
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True, env=fixture_environment())
        self.addCleanup(shutil.rmtree, remote)
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "-u", "origin", "main")
        original = self.environment.run

        def run(args, **kwargs):
            if args[0] == "git":
                return preflight.System().run(args, **kwargs)
            return original(args, **kwargs)

        self.environment.run = run
        return self.git("rev-parse", "HEAD")

    def test_current_base_passes_and_dirty_files_are_preserved(self):
        head = self.repository()
        self.write("keep.txt", "unfinished work")
        report = self.check()
        self.assertEqual(report["exit_code"], 0, report)
        self.assertIn(head, str(report))
        self.assertIn("uncommitted", str(report))
        self.assertEqual((self.root / "keep.txt").read_text(), "unfinished work")

    def test_stale_tracking_ref_does_not_hide_new_remote_commit(self):
        original = self.repository()
        self.git("commit", "--allow-empty", "-m", "new remote base")
        latest = self.git("rev-parse", "HEAD")
        self.git("push", "origin", "main")
        self.git("switch", "--detach", original)
        self.git("update-ref", "refs/remotes/origin/main", original)
        report = self.check()
        self.assertEqual(report["exit_code"], 1, report)
        self.assertIn(latest, str(report))
        self.assertIn("behind=1", str(report))
        self.assertEqual(self.git("rev-parse", "HEAD"), original)

    def test_unavailable_remote_is_unknown_and_local_checks_still_run(self):
        self.repository()
        self.git("remote", "set-url", "origin", str(self.root / "missing.git"))
        report = self.check()
        self.assertEqual(report["exit_code"], 2, report)
        self.assertIn("unknown", str(report))
        self.assertEqual(next(r for r in report["results"] if r["check"] == "loopback")["status"], "pass")

    def test_review_of_older_commit_requires_matching_checkout_but_no_remote(self):
        original = self.repository()
        self.git("commit", "--allow-empty", "-m", "new remote base")
        newer = self.git("rev-parse", "HEAD")
        self.git("push", "origin", "main")
        self.git("switch", "--detach", original)
        self.git("remote", "set-url", "origin", str(self.root / "missing.git"))
        self.assertEqual(self.check(mode="review", revision=original)["exit_code"], 0)
        self.assertEqual(self.check(mode="review", revision=newer)["exit_code"], 1)
        self.assertEqual(self.check(mode="review")["exit_code"], 1)

    def test_implementation_in_source_export_has_unknown_freshness(self):
        report = self.check()
        self.assertEqual(report["exit_code"], 2)

    def test_canonical_command_emits_a_report_from_an_export(self):
        (self.root / "scripts").mkdir()
        shutil.copy(SCRIPT, self.root / "scripts/preflight.py")
        shutil.copy(SCRIPT.with_suffix(".sh"), self.root / "scripts/preflight.sh")
        result = subprocess.run(["bash", str(self.root / "scripts/preflight.sh"), "--mode", "local", "--json"],
                                text=True, capture_output=True, timeout=10, env=fixture_environment())
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, report["exit_code"])
        self.assertEqual(len(report["results"]), 8)
        self.assertEqual(next(r for r in report["results"] if r["check"] == "freshness")["status"], "not-applicable")

    def test_local_timeout_fails_but_network_timeout_is_unknown(self):
        self.environment.responses["node"] = subprocess.TimeoutExpired("node", 5)
        self.assertEqual(self.check(mode="local")["exit_code"], 1)
        self.environment.responses.clear()
        self.repository()
        previous = self.environment.run

        def timeout_remote(args, **kwargs):
            if args[:2] == ["git", "ls-remote"]:
                self.assertLessEqual(kwargs["timeout"], 15)
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            return previous(args, **kwargs)

        self.environment.run = timeout_remote
        self.assertEqual(self.check()["exit_code"], 2)
        self.environment.loopback_error = PermissionError(1, "denied")
        self.assertEqual(self.check()["exit_code"], 1)

    def test_overall_deadline_marks_unfinished_checks_unknown(self):
        now = [0]
        previous = self.environment.run

        def slow(args, **kwargs):
            result = previous(args, **kwargs)
            now[0] = 31
            return result

        self.environment.run = slow
        report = self.check(mode="local", clock=lambda: now[0])
        self.assertEqual(report["exit_code"], 2)
        self.assertIn("deadline exhausted", str(report))

    def test_remote_base_override_and_divergence(self):
        self.repository()
        self.git("branch", "stacked")
        self.git("push", "origin", "stacked")
        self.assertEqual(self.check(base="origin/stacked")["exit_code"], 0)
        self.git("commit", "--allow-empty", "-m", "own change")
        own = self.git("rev-parse", "HEAD")
        self.git("switch", "stacked")
        self.git("commit", "--allow-empty", "-m", "base change")
        self.git("push", "origin", "stacked")
        self.git("switch", "--detach", own)
        report = self.check(base="origin/stacked")
        self.assertEqual(report["exit_code"], 1)
        self.assertIn("behind=1, ahead=1", str(report))

    def test_missing_remote_object_is_fetched_without_moving_refs(self):
        original = self.repository()
        donor = self.root / "donor"
        subprocess.run(["git", "clone", self.git("remote", "get-url", "origin"), str(donor)],
                       check=True, capture_output=True, env=fixture_environment())
        def donor_git(*args):
            return subprocess.run(["git", "-C", str(donor), "-c", "user.name=Fixture",
                                   "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
                                   "-c", "core.hooksPath=/dev/null", *args],
                                  check=True, capture_output=True, text=True, env=fixture_environment()).stdout.strip()
        donor_git("switch", "main")
        donor_git("commit", "--allow-empty", "-m", "remote only")
        latest = donor_git("rev-parse", "HEAD")
        donor_git("push", "origin", "main")
        self.write(".git/FETCH_HEAD", "preserve this receipt")
        report = self.check()
        self.assertEqual(report["exit_code"], 1, report)
        self.assertIn(latest, str(report))
        self.assertIn("behind=1", str(report))
        self.assertEqual(self.git("rev-parse", "origin/main"), original)
        self.assertEqual((self.root / ".git/FETCH_HEAD").read_text(), "preserve this receipt")

    def test_python_lint_package_mismatch_and_unlaunchable_tool(self):
        interpreter = str(self.root / ".venv-lint/bin/python")
        self.environment.responses[interpreter] = (0, '{"ruff":"0.16.0","shellcheck-py":"0.11.0.1"}', "")
        self.assertEqual(self.check(mode="local")["exit_code"], 1)
        self.environment.responses.clear()
        self.environment.responses[str(self.root / ".venv-lint/bin/shellcheck")] = OSError(8, "Exec format error")
        report = self.check(mode="local")
        self.assertEqual(report["exit_code"], 1)
        self.assertIn("Exec format error", str(report))

    def test_missing_python_is_diagnosed_by_the_canonical_launcher(self):
        tools = self.root / "bin"
        tools.mkdir()
        (tools / "dirname").symlink_to(shutil.which("dirname"))
        result = subprocess.run([shutil.which("bash"), str(SCRIPT.with_suffix(".sh")), "--json"],
                                capture_output=True, text=True, env=fixture_environment(PATH=str(tools)))
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(report["results"]), 8)
        self.assertIn("Missing python3", str(report))

    def test_real_process_adapter_enforces_its_timeout(self):
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            preflight.System().run([sys.executable, "-I", "-c", "import time; time.sleep(60)"],
                                   cwd=self.root, timeout=0.1)
        self.assertLess(time.monotonic() - started, 3)

    def test_npm_must_be_available_for_release_verification(self):
        self.environment.responses["npm"] = FileNotFoundError(2, "missing", "npm")
        self.assertEqual(self.check(mode="local")["exit_code"], 1)

    def test_local_export_does_not_require_git(self):
        self.environment.responses["git"] = FileNotFoundError(2, "missing", "git")
        report = self.check(mode="local")
        self.assertEqual(report["exit_code"], 0, report)
        self.assertEqual(next(r for r in report["results"] if r["check"] == "checkout")["status"], "not-applicable")
        self.assertEqual(self.check()["exit_code"], 2)

    def test_shellcheck_executable_version_must_match_its_pinned_package(self):
        self.environment.responses[str(self.root / ".venv-lint/bin/shellcheck")] = (0, "version: 0.9.0", "")
        report = self.check(mode="local")
        self.assertEqual(report["exit_code"], 1, report)
        self.assertIn("shellcheck", str(report))

    def test_runtime_startup_checks_preserve_node_and_python_settings(self):
        for variable, value, check in [
            ("NODE_OPTIONS", "--definitely-invalid-node-option", "node"),
            ("PYTHONHOME", str(self.root / "missing-python-home"), "python"),
        ]:
            with self.subTest(variable=variable):
                with patch.dict(os.environ, {variable: value}):
                    report = preflight.run_preflight(self.root, mode="local")
                result = next(item for item in report["results"] if item["check"] == check)
                self.assertEqual(result["status"], "fail", result)
                self.assertIn("could not start", result["detail"])

    def test_timeout_does_not_wait_for_a_detached_pipe_writer(self):
        pidfile = self.root / "detached.pid"
        code = (
            "import pathlib, subprocess, sys, time; "
            "child = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(2)'], start_new_session=True); "
            "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(30)"
        )
        started = time.monotonic()
        try:
            with self.assertRaises(subprocess.TimeoutExpired):
                preflight.System().run([sys.executable, "-I", "-c", code, str(pidfile)],
                                       cwd=self.root, timeout=0.15)
            self.assertLess(time.monotonic() - started, 1)
        finally:
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_git_keeps_authentication_settings_but_ignores_repository_redirection(self):
        self.write("bin/git", '#!/bin/sh\nprintf "%s\n" "$GIT_SSH_COMMAND" "${GIT_DIR-unset}" "$GIT_TERMINAL_PROMPT" "$SSH_ASKPASS_REQUIRE"\n')
        (self.root / "bin/git").chmod(0o755)
        settings = {
            "PATH": str(self.root / "bin") + os.pathsep + os.environ["PATH"],
            "GIT_SSH_COMMAND": "ssh -i fixture-key",
            "GIT_DIR": str(self.root / "wrong-repository"),
        }
        with patch.dict(os.environ, settings):
            result = preflight.System().run(["git", "--version"], cwd=self.root, timeout=1)
        self.assertEqual(result.stdout.splitlines(), ["ssh -i fixture-key", "unset", "0", "never"])

    def test_canonical_launcher_reports_broken_python_environment(self):
        (self.root / "scripts").mkdir()
        shutil.copy(SCRIPT, self.root / "scripts/preflight.py")
        shutil.copy(SCRIPT.with_suffix(".sh"), self.root / "scripts/preflight.sh")
        result = subprocess.run(["bash", str(self.root / "scripts/preflight.sh"), "--mode", "local", "--json"],
                                text=True, capture_output=True, timeout=10,
                                env=fixture_environment(PYTHONHOME=str(self.root / "missing-python-home")))
        report = json.loads(result.stdout)
        python_result = next(item for item in report["results"] if item["check"] == "python")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(python_result["status"], "fail")

    def test_git_suppresses_environment_and_configured_askpass(self):
        marker = self.root / "askpass-called"
        self.write("askpass.sh", '#!/bin/sh\nprintf called > "$HEARTH_TEST_ASKPASS_MARKER"\nprintf fixture-credential\n')
        helper = self.root / "askpass.sh"
        helper.chmod(0o755)
        command = ["git", "-c", "credential.helper=", "-c",
                   "alias.preflight-probe=!printf 'protocol=https\\nhost=example.invalid\\n\\n' | git credential fill"]
        for source in ("environment", "configuration"):
            with self.subTest(source=source):
                marker.unlink(missing_ok=True)
                settings = {"HEARTH_TEST_ASKPASS_MARKER": str(marker), "GIT_CONFIG_GLOBAL": os.devnull,
                            "GIT_CONFIG_NOSYSTEM": "1"}
                with patch.dict(os.environ, settings):
                    os.environ.pop("GIT_ASKPASS", None)
                    args = list(command)
                    if source == "environment":
                        os.environ["GIT_ASKPASS"] = str(helper)
                    else:
                        args += ["-c", "core.askPass=" + str(helper)]
                    result = preflight.System().run(args + ["preflight-probe"], cwd=self.root, timeout=2)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(marker.exists(), "interactive askpass helper was invoked")


if __name__ == "__main__":
    unittest.main()
