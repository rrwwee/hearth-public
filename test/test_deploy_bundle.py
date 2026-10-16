"""Deployment CLI integration tests with real Git and isolated command adapters."""
import json
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import tempfile
import unittest
import uuid
from fixture_environment import fixture_environment
from deployment_candidate import assemble_validation_candidate

ROOT = Path(__file__).resolve().parents[1]


class ValidationCandidateTests(unittest.TestCase):
    def test_candidate_excludes_private_ignored_generated_and_outer_test_files(self):
        with tempfile.TemporaryDirectory(prefix="hearth-candidate-") as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            env = fixture_environment()
            included = {
                "server.js": "// current server\n",
                "lib/current.js": "// library\n",
                "demo/current.js": "// demo\n",
                "public/nested/current.js": "// public module\n",
                "public/styles.css": "body {}\n",
                "public/index.html": "<!doctype html>\n",
                "pi/dashboard/collector.py": "# collector\n",
                "pi/dashboard/launcher.sh": "#!/bin/sh\n",
                "pi/dashboard/config/cluster.example.json": "{}\n",
            }
            excluded = (
                ".env", "config/cluster.json", "state/state.json", "unrelated.js",
                "public/ignored.js", "public/background.local.js", "public/background.mp4",
                "public/.env.js", "public/build/output.js", "lib/node_modules/dependency/index.js",
                "demo/coverage/output.js", "pi/dashboard/__pycache__/collector.pyc",
                "pi/dashboard/state/state.json", "pi/dashboard/config/cluster.json",
                "public/notes.txt", "test/test_deploy_bundle.py", "test/outer.test.js",
            )
            for name, contents in {**included, **dict.fromkeys(excluded, "must not enter candidate\n")}.items():
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents)
            (source / "test/test_dashboard_agent.py").write_text("# selected test\n")
            (source / "test/fixture_environment.py").write_text("# selected helper\n")
            (source / "package.json").write_text('{"scripts":{"test":"must not run outer suite"}}')
            (source / ".gitignore").write_text((ROOT / ".gitignore").read_text() + "\npublic/ignored.js\n")
            (source / "public/link.js").symlink_to(source / ".env")
            (source / "public/linked-tree").symlink_to(source / "test", target_is_directory=True)
            (source / "pi/dashboard/launcher.sh").chmod(0o755)
            subprocess.run(["git", "init", "-q", str(source)], env=env, check=True)
            # Even an accidentally tracked ignored file must not be copied.
            subprocess.run(["git", "-C", str(source), "add", "-f", "public/ignored.js"], env=env, check=True)

            candidate = root / "candidate"
            assemble_validation_candidate(source, candidate)

            committed = subprocess.check_output(
                ["git", "-C", str(candidate), "ls-tree", "-r", "--name-only", "HEAD"], env=env, text=True)
            self.assertEqual(set(committed.splitlines()), set(included) | {
                "test/test_dashboard_agent.py", "test/fixture_environment.py", "test/validation.test.js",
                "package.json", "check-validation-input.cjs",
            })
            self.assertTrue(os.access(candidate / "pi/dashboard/launcher.sh", os.X_OK))
            self.assertEqual(sorted(path.name for path in (candidate / "test").iterdir()),
                             ["fixture_environment.py", "test_dashboard_agent.py", "validation.test.js"])
            self.assertNotIn("outer suite", (candidate / "package.json").read_text())

    def test_candidate_includes_new_imports_and_uncommitted_source(self):
        with tempfile.TemporaryDirectory(prefix="hearth-candidate-") as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            env = fixture_environment()

            def git(*args):
                return subprocess.check_output(["git", "-C", str(source), *args], env=env, text=True)

            (source / "server.js").write_text('export const value = "committed";\n')
            (source / "test").mkdir()
            for name in ("test_dashboard_agent.py", "fixture_environment.py"):
                shutil.copy2(ROOT / "test" / name, source / "test" / name)
            git("init", "-q")
            git("add", ".")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com",
                "commit", "-qm", "Original source")
            (source / "public/nested").mkdir(parents=True)
            (source / "public/nested/new-module.js").write_text('export const value = "working tree";\n')
            (source / "server.js").write_text('export { value } from "./public/nested/new-module.js";\n')

            candidate = root / "candidate"
            assemble_validation_candidate(source, candidate)

            result = subprocess.check_output(
                ["node", "--input-type=module", "-e", 'import { value } from "./server.js"; console.log(value);'],
                cwd=candidate, env=env, text=True)
            self.assertEqual(result.strip(), "working tree")
            committed = subprocess.check_output(
                ["git", "-C", str(candidate), "show", "HEAD:public/nested/new-module.js"], env=env, text=True)
            self.assertEqual(committed, 'export const value = "working tree";\n')
            self.assertEqual(git("show", "HEAD:server.js"), 'export const value = "committed";\n')


class BundleDeploymentTests(unittest.TestCase):
    def setUp(self):
        # Fixtures own their installations and repositories, even when invoked
        # by a live deployment or a Git hook.
        self.env = fixture_environment()
        self.temp = tempfile.TemporaryDirectory(prefix="hearth-bundle-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.installation = self.root / "installation"
        self.bin = self.installation / "bin"
        self.installation.mkdir()
        self.bin.mkdir()
        self.source.mkdir()
        (self.source / "pi/dashboard").mkdir(parents=True)
        for name in ("deploy-from-git.sh", "deploy_activation.py", "deploy_protocol.py"):
            if (ROOT / "pi/dashboard" / name).exists():
                shutil.copy2(ROOT / "pi/dashboard" / name, self.source / "pi/dashboard" / name)
        (self.source / "server.js").write_text("// committed source\n")
        (self.source / "public").mkdir()
        (self.source / "public/committed.txt").write_text("reviewed\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", "Fixture")
        self.commit = self.git("rev-parse", "HEAD").strip()
        self.git("update-ref", "refs/remotes/origin/main", self.commit)
        (self.source / "server.js").write_text("// local edits must survive\n")
        (self.source / "untracked-secret").write_text("not in release\n")
        adapter = self.bin / "adapter.py"
        shutil.copy2(ROOT / "test/fixtures/deploy-command.py", adapter)
        adapter.chmod(0o755)
        for name in ("npm", "node", "systemctl", "curl", "sleep", "install"):
            (self.bin / name).symlink_to(adapter)
        ssh = self.bin / "ssh"
        ssh.write_text('''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
settings = json.loads((Path(os.environ["HEARTH_DEPLOY_FIXTURE"]) / "fixture.json").read_text())
command = sys.argv[-1]
if "--receive" in command:
    if settings.get("moveRef"):
        subprocess.run(["git", "-C", os.environ["HEARTH_SOURCE_FIXTURE"], "update-ref", "refs/remotes/origin/main", settings["moveRef"]], check=True)
    if settings.get("transfer"):
        data = sys.stdin.buffer.read()
        data = data[:-10] if settings["transfer"] == "truncate" else data[:-1] + bytes([data[-1] ^ 1])
        sys.exit(subprocess.run(["sh", "-c", command], input=data).returncode)
if "--deploy-bundle" in command and settings.get("loseResponse"):
    subprocess.run(["sh", "-c", command])
    sys.exit(255)
os.execvp("sh", ["sh", "-c", command])
''')
        ssh.chmod(0o755)
        for path in ("systemd", "state", "config", "releases/old", "public"):
            (self.installation / path).mkdir(parents=True)
        (self.installation / "current").symlink_to("releases/old")
        (self.installation / "fixture.json").write_text(json.dumps({"commit": self.commit}))
        (self.installation / "service.json").write_text(json.dumps({"active": "active", "enabled": "disabled", "release": "old-release-identity"}))
        (self.installation / "systemd/dashboard-hearth-web.service").write_text(
            "[Service]\nWorkingDirectory=/legacy/hearth\n"
            "Environment=HEARTH_MODE=live HEARTH_AGENT_MODE=local HEARTH_RELEASE=old-release-identity\n"
            "ExecStart=/usr/bin/node server.js\n")
        for name in ("deploy-from-git.sh", "deploy_protocol.py"):
            if (ROOT / "pi/dashboard" / name).exists():
                shutil.copy2(ROOT / "pi/dashboard" / name, self.installation / name)
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        HEARTH_DEPLOY_BASE=str(self.installation), HEARTH_BASE_DIR=str(self.installation),
                        HEARTH_SYSTEMD_USER_DIR=str(self.installation / "systemd"),
                        HEARTH_SOURCE_FIXTURE=str(self.source),
                        HEARTH_DEPLOY_FIXTURE=str(self.installation), PYTHONDONTWRITEBYTECODE="1")
        for key in ("HEARTH_REPOSITORY_URL", "HEARTH_REPOSITORY_DIR", "HEARTH_DEPLOY_ATTEMPT"):
            self.env.pop(key, None)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.source), *args], text=True, env=self.env)

    def deploy(self, *extra):
        return subprocess.run(["bash", str(ROOT / "scripts/deploy-to-pi.sh"), "--bundle",
                               "--source", str(self.source), "fixture-host", "origin/main", *extra],
                              env=self.env, text=True, capture_output=True, timeout=30)

    def deploy_fetch(self):
        return subprocess.run(["bash", str(ROOT / "scripts/deploy-to-pi.sh"), "fixture-host", self.commit],
                              env=dict(self.env, HEARTH_REPOSITORY_URL=str(self.source)),
                              text=True, capture_output=True, timeout=30)

    def settings(self, **settings):
        (self.installation / "fixture.json").write_text(json.dumps(dict(commit=self.commit, **settings)))

    def command(self, *args, **options):
        return subprocess.run(["bash", str(self.installation / "deploy-from-git.sh"), *map(str, args)],
                              env=self.env, capture_output=True, **options)

    def receive(self, wrong_commit=False):
        attempt = uuid.uuid4().hex
        ref = "refs/hearth/test/" + attempt
        bundle = self.root / (attempt + ".bundle")
        self.git("update-ref", ref, self.commit)
        try:
            self.git("bundle", "create", str(bundle), ref)
        finally:
            self.git("update-ref", "-d", ref)
        data = bundle.read_bytes()
        result = self.command("--receive", attempt, "a" * 40 if wrong_commit else self.commit,
                              hashlib.sha256(data).hexdigest(), len(data), input=data)
        self.assertEqual(result.returncode, 0, result.stderr)
        return attempt

    def wait_for_activation(self):
        for _ in range(100):
            if (self.installation / "starting").exists():
                return
            time.sleep(0.05)
        self.fail("Fixture did not reach activation")

    def unresolved_activation(self, **settings):
        self.settings(holdStart=True, holdSeconds=0.5, **settings)
        attempt = self.receive()
        with (self.root / "output").open("wb") as log:
            child = subprocess.Popen(["bash", str(self.installation / "deploy-from-git.sh"), "--deploy-bundle", attempt],
                                     env=self.env, stdout=log, stderr=log)
            self.addCleanup(lambda: child.kill() if child.poll() is None else None)
            self.wait_for_activation()
            child.kill()
            child.wait(timeout=5)
            directory = self.installation / "state/deploy-attempts" / attempt
            for _ in range(160):
                recovered = (settings.get("restartFailure")
                             and not (self.installation / "state/deploy-recovery").exists()
                             and os.readlink(self.installation / "current") == "releases/old")
                if (directory / "activation-result.json").exists() or recovered:
                    break
                time.sleep(0.05)
            else:
                self.fail("Fixture activation did not finish:\n" + (self.root / "output").read_text())
        self.assertTrue((directory / "unresolved.json").exists())
        return attempt, directory

    def test_reconciliation_preserves_its_existing_checks_without_restarting(self):
        attempt, directory = self.unresolved_activation()
        # Reconciliation currently verifies release identity, not activation's
        # command, working-directory, or live/local-mode requirements. A new
        # drop-in was not among the operator files captured before activation.
        late = self.installation / "systemd/dashboard-hearth-web.service.d/99-later.conf"
        late.write_text("[Service]\nWorkingDirectory=/later\nExecStart=/bin/false\n"
                        "Environment=HEARTH_MODE=demo HEARTH_AGENT_MODE=ssh\n")
        state = (self.installation / "service.json").read_bytes()
        self.settings()
        result = self.command("--reconcile", attempt, "activated")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.installation / "service.json").read_bytes(), state)
        self.assertEqual(json.loads((directory / "receipt.json").read_text())["reconciled_outcome"], "activated")
        self.assertFalse((directory / "unresolved.json").exists())

    def test_older_coordinator_reconciles_new_release_through_legacy_helpers(self):
        attempt, directory = self.unresolved_activation()
        # The old coordinator calls individual activation helpers and consumes
        # protocol-1 evidence itself. Freeze that method at the old version.
        shutil.copy2(ROOT / "test/fixtures/deployment_v1.py", self.installation / "deployment_v1.py")
        protocol = self.installation / "deploy_protocol.py"
        source = protocol.read_text()
        start = source.index("    def reconcile(self, attempt, outcome):")
        end = source.index("\n\ndef remote(", start)
        protocol.write_text(source[:start] + '''    def reconcile(self, attempt, outcome):
        from deployment_v1 import reconcile
        return reconcile(self, attempt, outcome)
''' + source[end:])
        self.settings()
        result = self.command("--reconcile", attempt, "activated")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((directory / "unresolved.json").exists())
        self.assertEqual(json.loads((directory / "receipt.json").read_text())["reconciled_outcome"], "activated")

    def test_reconciliation_rejections_preserve_evidence_and_do_not_restart(self):
        attempt, directory = self.unresolved_activation()
        current = self.installation / "current"
        selected = os.readlink(current)
        state = (self.installation / "service.json").read_bytes()
        receipt = (directory / "receipt.json").read_bytes()
        self.settings()
        current.unlink()
        current.symlink_to("releases/old")
        rejected = self.command("--reconcile", attempt, "activated")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn(b"Selected release does not match", rejected.stderr)
        current.unlink()
        current.symlink_to(selected)
        self.settings(wrongRelease=True)
        rejected = self.command("--reconcile", attempt, "activated")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn(b"Running release does not match", rejected.stderr)
        self.assertTrue((directory / "unresolved.json").exists())
        self.assertTrue((directory / "bundle").exists())
        self.assertEqual((directory / "receipt.json").read_bytes(), receipt)
        self.assertEqual((self.installation / "service.json").read_bytes(), state)
        self.settings()
        self.assertEqual(self.command("--reconcile", attempt, "activated").returncode, 0)

    def test_new_coordinator_reconciles_helper_only_protocol_1_release(self):
        attempt, directory = self.unresolved_activation(restartFailure=True)
        self.assertEqual(os.readlink(self.installation / "current"), "releases/old")
        # The historical release has the original helper interface, with no
        # evidence-verification entry point. Keep its implementation frozen.
        release = self.installation / "releases" / self.commit
        shutil.copy2(ROOT / "test/fixtures/deployment_v1.py", release / "pi/dashboard/deploy_activation.py")
        self.settings()
        unit = self.installation / "systemd/dashboard-hearth-web.service"
        original = unit.read_text()
        unit.write_text(original + "# operator change\n")
        rejected = self.command("--reconcile", attempt, "rolled-back")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn(b"Configuration does not match", rejected.stderr)
        self.assertTrue((directory / "unresolved.json").exists())
        unit.write_text(original)
        result = self.command("--reconcile", attempt, "rolled-back")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((directory / "unresolved.json").exists())

    def test_bundle_deploys_committed_content_and_preserves_local_edits(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        release = self.installation / "releases" / self.commit
        self.assertEqual((release / "server.js").read_text(), "// committed source\n")
        self.assertFalse((release / "untracked-secret").exists())
        self.assertEqual((self.source / "server.js").read_text(), "// local edits must survive\n")
        self.assertEqual((self.source / "untracked-secret").read_text(), "not in release\n")
        self.assertEqual(self.git("for-each-ref", "refs/hearth/"), "")
        self.assertIn(self.commit, result.stdout)
        self.assertIn("dirty", result.stdout.lower())
        state = json.loads((self.installation / "service.json").read_text())
        self.assertEqual((state["active"], state["enabled"], state["release"]), ("active", "disabled", self.commit))
        self.assertFalse((self.installation / "repository").exists())

    def test_completed_activation_with_failed_receipt_blocks_both_transports(self):
        self.settings(receiptFailure=True)
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Completion could not be recorded", result.stderr)
        state = json.loads((self.installation / "service.json").read_text())
        self.assertEqual(state["release"], self.commit)
        attempts = list((self.installation / "state/deploy-attempts").iterdir())
        self.assertEqual(len(attempts), 1)
        self.assertTrue((attempts[0] / "unresolved.json").exists())
        self.assertTrue((attempts[0] / "bundle").exists())
        self.settings()
        retry = self.deploy()
        self.assertNotEqual(retry.returncode, 0)
        direct = subprocess.run(["bash", str(self.installation / "deploy-from-git.sh"), self.commit],
                                env=self.env, capture_output=True, text=True)
        self.assertNotEqual(direct.returncode, 0)
        self.assertIn("Unresolved", direct.stderr)
        self.assertEqual(json.loads((self.installation / "service.json").read_text()), state)

    def test_damaged_transfers_do_not_restart_or_select_a_release(self):
        for mode in ("corrupt", "truncate"):
            with self.subTest(mode=mode):
                self.settings(transfer=mode)
                result = self.deploy()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(os.readlink(self.installation / "current"), "releases/old")
                self.assertNotIn("starts", json.loads((self.installation / "service.json").read_text()))
                for directory in (self.installation / "state/deploy-attempts").iterdir():
                    self.assertEqual(json.loads((directory / "receipt.json").read_text())["outcome"], "failed-before-activation")
                    self.assertFalse((directory / "bundle.part").exists())

    def test_legacy_launcher_is_never_invoked_as_a_capability_probe(self):
        sentinel = self.installation / "legacy-invoked"
        (self.installation / "deploy-from-git.sh").write_text("#!/bin/sh\ntouch " + str(sentinel) + "\n")
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("first-upgrade", result.stderr)
        self.assertFalse(sentinel.exists())
        self.assertFalse((self.installation / "state/deploy-attempts").exists())

    def test_incompatible_candidate_cannot_remove_the_guard(self):
        path = self.source / "pi/dashboard/deploy_activation.py"
        path.write_text(path.read_text().replace("# Hearth deployment protocol: 1", "# legacy"))
        self.git("add", "pi/dashboard/deploy_activation.py")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", "Legacy protocol")
        self.git("update-ref", "refs/remotes/origin/main", self.git("rev-parse", "HEAD").strip())
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported deployment protocol", result.stderr)
        self.assertEqual(os.readlink(self.installation / "current"), "releases/old")

    def test_ref_moving_during_transfer_cannot_change_the_commit(self):
        (self.source / "public/new.txt").write_text("later commit\n")
        self.git("add", "public/new.txt")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", "Later")
        later = self.git("rev-parse", "HEAD").strip()
        self.settings(moveRef=later)
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads((self.installation / "service.json").read_text())["release"], self.commit)
        self.assertEqual(self.git("rev-parse", "origin/main").strip(), later)

    def test_lost_success_response_does_not_retry_activation(self):
        self.settings(loseResponse=True)
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("before retrying", result.stderr)
        state = json.loads((self.installation / "service.json").read_text())
        self.assertEqual(state["starts"], 1)
        self.assertEqual(state["release"], self.commit)

    def test_wrong_commit_is_rejected_before_activation(self):
        attempt = self.receive(wrong_commit=True)
        result = self.command("--deploy-bundle", attempt)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"requested commit", result.stderr)
        self.assertEqual(os.readlink(self.installation / "current"), "releases/old")

    def test_cancellation_restores_previous_installation_and_cleans_transfer(self):
        self.settings(holdStart=True, holdSeconds=1)
        attempt = self.receive()
        with (self.root / "output").open("wb") as log:
            child = subprocess.Popen(["bash", str(self.installation / "deploy-from-git.sh"), "--deploy-bundle", attempt],
                                     env=self.env, stdout=log, stderr=log)
            self.addCleanup(lambda: child.kill() if child.poll() is None else None)
            self.wait_for_activation()
            cancelled = self.command("--cancel", attempt)
            self.assertEqual(cancelled.returncode, 0)
            self.assertNotEqual(child.wait(timeout=8), 0)
        self.assertEqual(os.readlink(self.installation / "current"), "releases/old")
        directory = self.installation / "state/deploy-attempts" / attempt
        self.assertEqual(json.loads((directory / "receipt.json").read_text())["outcome"], "rolled-back")
        self.assertFalse((directory / "bundle").exists())

    def test_interrupted_coordinator_requires_reconciliation_even_after_child_finishes(self):
        self.settings(holdStart=True, holdSeconds=1)
        attempt = self.receive()
        with (self.root / "output").open("wb") as log:
            child = subprocess.Popen(["bash", str(self.installation / "deploy-from-git.sh"), "--deploy-bundle", attempt],
                                     env=self.env, stdout=log, stderr=log)
            self.addCleanup(lambda: child.kill() if child.poll() is None else None)
            self.wait_for_activation()
            child.kill()
            child.wait(timeout=5)
            time.sleep(1.5)
        result = self.command(self.commit)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Unresolved", result.stderr)
        directory = self.installation / "state/deploy-attempts" / attempt
        self.assertTrue((directory / "unresolved.json").exists())
        self.assertTrue((directory / "bundle").exists())

        reconciled = self.command("--reconcile", attempt, "activated")
        self.assertEqual(reconciled.returncode, 0, reconciled.stderr)
        self.assertFalse((directory / "unresolved.json").exists())
        self.assertFalse((directory / "bundle").exists())

    def test_staging_failure_cleans_its_artifacts_without_touching_other_receipts(self):
        self.settings(validationFailure=True)
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        attempts = list((self.installation / "state/deploy-attempts").iterdir())
        self.assertEqual(len(attempts), 1)
        receipt = json.loads((attempts[0] / "receipt.json").read_text())
        self.assertEqual(receipt["outcome"], "failed-before-activation")
        self.assertEqual(sorted(p.name for p in attempts[0].iterdir()), ["diagnostics.log", "receipt.json"])
        self.settings()
        self.assertEqual(self.deploy().returncode, 0)
        self.assertTrue((attempts[0] / "receipt.json").exists())

    def test_prerequisite_bundle_is_rejected_without_using_the_remote_cache(self):
        (self.source / "public/later.txt").write_text("later\n")
        self.git("add", "public/later.txt")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", "Later")
        later = self.git("rev-parse", "HEAD").strip()
        bundle = self.root / "incremental.bundle"
        self.git("bundle", "create", str(bundle), "HEAD", "^" + self.commit)
        data = bundle.read_bytes()
        attempt = uuid.uuid4().hex
        received = self.command("--receive", attempt, later, hashlib.sha256(data).hexdigest(), len(data), input=data)
        self.assertEqual(received.returncode, 0)
        result = self.command("--deploy-bundle", attempt)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(self.installation / "current"), "releases/old")
        self.assertFalse((self.installation / "repository").exists())

    def test_failure_to_record_activation_prevents_service_mutation(self):
        self.settings(blockActivationRecord=True)
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(self.installation / "current"), "releases/old")
        self.assertNotIn("starts", json.loads((self.installation / "service.json").read_text()))

    def test_inactive_installation_returns_to_inactivity(self):
        state = self.installation / "service.json"
        state.write_text(json.dumps({"active": "inactive", "enabled": "disabled", "release": "old-release-identity"}))
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("selected; service returned to inactive", result.stdout)
        self.assertEqual(json.loads(state.read_text())["active"], "inactive")

    def test_explicit_bundle_bootstrap_preserves_legacy_launcher_on_failure(self):
        legacy = "#!/bin/sh\nexit 99\n"
        (self.installation / "deploy-from-git.sh").write_text(legacy)
        (self.installation / "deploy_protocol.py").unlink()
        self.settings(restartFailure=True)
        attempt = uuid.uuid4().hex
        bundle = self.root / "bootstrap.bundle"
        self.git("bundle", "create", str(bundle), "HEAD")
        data = bundle.read_bytes()
        command = ["bash", str(ROOT / "pi/dashboard/deploy-from-git.sh")]
        received = subprocess.run(command + ["--receive", attempt, self.commit, hashlib.sha256(data).hexdigest(), str(len(data))],
                                  env=self.env, input=data, capture_output=True)
        self.assertEqual(received.returncode, 0, received.stderr)
        failed = subprocess.run(command + ["--deploy-bundle", attempt], env=self.env, capture_output=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual((self.installation / "deploy-from-git.sh").read_text(), legacy)
        self.assertFalse((self.installation / "deploy_protocol.py").exists())
        self.assertEqual(os.readlink(self.installation / "current"), "releases/old")

    def test_rollback_reconciliation_rejects_changed_operator_configuration(self):
        dropins = self.installation / "systemd/dashboard-hearth-web.service.d"
        dropins.mkdir()
        custom = dropins / "10-private.conf"
        original = "[Service]\nEnvironment=OPERATOR_SETTING=original\n"
        custom.write_text(original)
        self.settings(restartFailure=True, holdStart=True, holdSeconds=1)
        attempt = self.receive()
        with (self.root / "output").open("wb") as log:
            child = subprocess.Popen(["bash", str(self.installation / "deploy-from-git.sh"), "--deploy-bundle", attempt],
                                     env=self.env, stdout=log, stderr=log)
            self.addCleanup(lambda: child.kill() if child.poll() is None else None)
            self.wait_for_activation()
            child.kill()
            child.wait(timeout=5)
            time.sleep(2)
        custom.write_text("[Service]\nEnvironment=OPERATOR_SETTING=changed\n")
        failed = self.command("--reconcile", attempt, "rolled-back")
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn(b"Configuration does not match", failed.stderr)
        custom.write_text(original)
        self.assertEqual(self.command("--reconcile", attempt, "rolled-back").returncode, 0)

    def test_direct_fetch_client_cancels_its_remote_attempt(self):
        cache = self.installation / "repository"
        subprocess.run(["git", "clone", "-q", "--no-checkout", str(self.source), str(cache)], check=True, env=self.env)
        env = dict(self.env, HEARTH_REPOSITORY_URL=str(self.source))
        self.settings(holdStart=True, holdSeconds=2)
        with (self.root / "output").open("wb") as log:
            child = subprocess.Popen(["bash", str(ROOT / "scripts/deploy-to-pi.sh"), "fixture-host", self.commit],
                                     env=env, stdout=log, stderr=log)
            self.addCleanup(lambda: child.kill() if child.poll() is None else None)
            self.wait_for_activation()
            child.send_signal(signal.SIGINT)
            self.assertNotEqual(child.wait(timeout=8), 0)
        self.assertEqual(os.readlink(self.installation / "current"), "releases/old")

    def test_cancelled_ready_transfer_does_not_leave_an_activation_guard(self):
        attempt = self.receive()
        self.assertEqual(self.command("--cancel", attempt).returncode, 0)
        result = self.command("--deploy-bundle", attempt)
        self.assertNotEqual(result.returncode, 0)
        directory = self.installation / "state/deploy-attempts" / attempt
        self.assertEqual(json.loads((directory / "receipt.json").read_text())["outcome"], "failed-before-activation")
        self.assertFalse((directory / "unresolved.json").exists())
        self.assertFalse((directory / "activation-before.json").exists())
        self.assertNotIn("starts", json.loads((self.installation / "service.json").read_text()))

    def test_fixture_repositories_ignore_the_parent_git_hook_environment(self):
        parent_commit = self.git("rev-parse", "HEAD")
        inherited = dict(self.env, GIT_DIR=str(self.source / ".git"), GIT_WORK_TREE=str(self.source))
        result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(ROOT / "test"),
                                 "-p", "test_deploy_bundle.py", "-k", "test_bundle_deploys_committed_content"],
                                env=inherited, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), parent_commit)

    def test_fixture_ignores_parent_installation_settings(self):
        foreign = self.root / "foreign"
        foreign.mkdir()
        config = foreign / "config"
        config.mkdir()
        sentinel = config / "cluster.json"
        sentinel.write_text('{"sentinel":"untouched"}')
        state = foreign / "state"
        state.mkdir()
        with (state / "deploy.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            inherited = dict(self.env, HEARTH_STATE_DIR=str(state), HEARTH_CONFIG_DIR=str(config),
                             HEARTH_RELEASES_DIR=str(foreign / "releases"),
                             HEARTH_CURRENT_LINK=str(foreign / "current"),
                             HEARTH_PRIVATE_DIR=str(foreign / "private"), PORT="invalid-port")
            result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(ROOT / "test"),
                                     "-p", "test_deploy_bundle.py", "-k", "test_bundle_deploys_committed_content"],
                                    env=inherited, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sentinel.read_text(), '{"sentinel":"untouched"}')
        self.assertEqual(sorted(path.relative_to(foreign).as_posix() for path in foreign.rglob("*")),
                         ["config", "config/cluster.json", "state", "state/deploy.lock"])

    def test_validation_isolates_tests_but_preserves_target_settings(self):
        self.settings(checkValidationEnvironment=True)
        self.env.update(HEARTH_FUTURE_SETTING="target-only", PORT="45123",
                        GIT_EDITOR="inherited-editor", VALIDATION_RUNTIME="preserved")
        for deploy in (self.deploy, self.deploy_fetch):
            with self.subTest(transport=deploy.__name__):
                result = deploy()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("Fixture validation environment verified", result.stdout)
                self.assertIn("Live validation environment verified", result.stdout)

    def test_validation_failures_identify_the_step_without_activating(self):
        for step in ("syntax", "fixtures", "live-configuration"):
            with self.subTest(step=step):
                self.settings(validationStepFailure=step)
                result = self.deploy()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Validation failed during " + step, result.stdout + result.stderr)
                receipts = list((self.installation / "state/deploy-attempts").glob("*/receipt.json"))
                receipt = max(receipts, key=lambda path: path.stat().st_mtime_ns)
                saved = json.loads(receipt.read_text())
                self.assertEqual(saved["phase"], "validation")
                self.assertEqual(saved["validationStep"], step)
                self.assertEqual(saved["outcome"], "failed-before-activation")
                self.assertIn("Validation: " + step, (receipt.parent / "diagnostics.log").read_text())
                self.assertEqual(os.readlink(self.installation / "current"), "releases/old")
                self.assertNotIn("starts", json.loads((self.installation / "service.json").read_text()))

    def test_public_commands_run_real_validation_against_the_target_configuration(self):
        # A small committed candidate has real npm tests and the real server's
        # live validator. Only transport and service operations use adapters.
        for name in ("npm", "node"):
            (self.bin / name).unlink()
        self.source = self.root / "validation-source"
        self.commit = assemble_validation_candidate(ROOT, self.source)
        self.env["HEARTH_SOURCE_FIXTURE"] = str(self.source)
        self.git("update-ref", "refs/remotes/origin/main", self.commit)
        self.settings()
        config = self.installation / "target-config"
        state = self.installation / "target-state"
        config.mkdir()
        state.mkdir()
        self.env.update(HEARTH_CONFIG_DIR=str(config), HEARTH_STATE_DIR=str(state),
                        HEARTH_FUTURE_SETTING="target-only", PORT="45123")
        for name in ("devices", "cluster", "notifications"):
            shutil.copy2(ROOT / f"pi/dashboard/config/{name}.example.json", config / f"{name}.json")
        shutil.copy2(ROOT / "pi/dashboard/config/ntfy-server.example.yml", config / "ntfy-server.yml")
        for deploy in (self.deploy, self.deploy_fetch):
            with self.subTest(transport=deploy.__name__):
                before_link = os.readlink(self.installation / "current")
                before_service = (self.installation / "service.json").read_bytes()
                (config / "notifications.json").write_text('{"enabled":"invalid"}')
                failed = deploy()
                self.assertNotEqual(failed.returncode, 0)
                self.assertIn("Notification configuration must declare enabled", failed.stdout + failed.stderr)
                self.assertIn("Validation failed during live-configuration", failed.stdout + failed.stderr)
                self.assertEqual(os.readlink(self.installation / "current"), before_link)
                self.assertEqual((self.installation / "service.json").read_bytes(), before_service)
                receipts = list((state / "deploy-attempts").glob("*/receipt.json"))
                receipt = json.loads(max(receipts, key=lambda path: path.stat().st_mtime_ns).read_text())
                self.assertEqual(receipt["outcome"], "failed-before-activation")
                self.assertEqual(receipt["validationStep"], "live-configuration")
                (config / "notifications.json").write_text('{"enabled":false}')
                passed = deploy()
                self.assertEqual(passed.returncode, 0, passed.stdout + passed.stderr)
                self.assertIn("Live configuration validation passed", passed.stdout)
                self.assertEqual(os.readlink(self.installation / "current"), str(self.installation / "releases" / self.commit))

        selected = os.readlink(self.installation / "current")
        service = (self.installation / "service.json").read_bytes()
        (self.source / "pi/dashboard/dashboard_agent.py").chmod(0o644)
        self.git("add", "pi/dashboard/dashboard_agent.py")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com",
                 "commit", "-qm", "Candidate with non-executable agent")
        self.commit = self.git("rev-parse", "HEAD").strip()
        self.git("update-ref", "refs/remotes/origin/main", self.commit)
        self.settings()
        failed = self.deploy()
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("configured local agent is not readable and executable", failed.stdout + failed.stderr)
        self.assertEqual(os.readlink(self.installation / "current"), selected)
        self.assertEqual((self.installation / "service.json").read_bytes(), service)


if __name__ == "__main__":
    unittest.main()
