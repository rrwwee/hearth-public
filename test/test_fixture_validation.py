"""Run public test entry points with settings from an unrelated installation."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FixtureValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hearth-foreign-")
        self.addCleanup(self.temp.cleanup)
        self.foreign = Path(self.temp.name).resolve()
        for name in ("state", "config", "private", "systemd", "repository", "releases"):
            (self.foreign / name).mkdir()
        (self.foreign / "config/cluster.json").write_text('{"sentinel":"configuration"}')
        (self.foreign / "state/sentinel.json").write_text('{"sentinel":"state"}')
        self.lock = (self.foreign / "state/deploy.lock").open("w")
        self.addCleanup(self.lock.close)
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.before = self.snapshot()
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("HEARTH_", "GIT_")) and key != "PORT"}
        paths = {"BASE_DIR": "", "STATE_DIR": "state", "CONFIG_DIR": "config",
                 "RELEASES_DIR": "releases", "CURRENT_LINK": "current", "PRIVATE_DIR": "private",
                 "SYSTEMD_USER_DIR": "systemd", "REPOSITORY_DIR": "repository",
                 "ENV_FILE": "hearth.env", "AGENT": "agent", "TEST_CLUSTER_FIXTURE": "commands.json"}
        self.env.update({"HEARTH_" + key: str(self.foreign / value) for key, value in paths.items()})
        self.env.update(HEARTH_MODE="live", HEARTH_VALIDATE_ONLY="1", HEARTH_RELEASE="foreign-release",
                        HEARTH_FUTURE_SETTING="must-not-inherit", PORT="invalid-port",
                        PYTHONDONTWRITEBYTECODE="1")

    def snapshot(self):
        return {str(path.relative_to(self.foreign)): path.read_bytes() if path.is_file() else None
                for path in self.foreign.rglob("*")}

    def test_python_fixtures_never_access_the_external_installation(self):
        # Fail on reads as well as writes, before importing the test modules.
        guard = '''
import os, sys, unittest
foreign = sys.argv[1]
def audit(event, args):
    if event in {"open", "os.mkdir", "os.listdir", "os.scandir", "os.remove", "os.rmdir", "os.rename"}:
        for arg in args:
            if isinstance(arg, (str, bytes, os.PathLike)):
                path = os.path.abspath(os.fsdecode(arg))
                if path == foreign or path.startswith(foreign + os.sep):
                    raise RuntimeError("Fixture accessed external installation: " + path)
sys.addaudithook(audit)
loader = unittest.TestLoader()
suite = unittest.TestSuite(loader.discover("test", pattern=name) for name in
                          ("test_dashboard_agent.py", "test_cluster_collection.py"))
sys.exit(not unittest.TextTestRunner().run(suite).wasSuccessful())
'''
        result = subprocess.run([sys.executable, "-c", guard, str(self.foreign)], cwd=ROOT,
                                env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.snapshot(), self.before)

    def test_javascript_fixture_commands_ignore_external_settings(self):
        result = subprocess.run(["node", "--test", "--test-name-pattern",
                                 "demo server is fixture-only|real collector observations|both launcher paths",
                                 "test/demo-server.test.js", "test/cluster-notifications.test.js",
                                 "test/vpn-lifecycle.test.js"], cwd=ROOT, env=self.env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.snapshot(), self.before)


if __name__ == "__main__":
    unittest.main()
