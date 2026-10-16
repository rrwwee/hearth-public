import importlib.util
import json
import os
import subprocess
import socket
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fixture_environment import fixture_environment


ROOT = Path(__file__).parents[1]
JOB = "42|researcher|RUNNING|00:02:00|2026-10-11T12:00:00|1|gpu01|4|gpu:1|simulation\n"
NODE = "NodeName=gpu01 State=MIXED CPUTot=16 CPUAlloc=4 RealMemory=64000 AllocMem=8000 Gres=gpu:2 AllocTRES=cpu=4,gres/gpu=1 CurrentWatts=100 AveWatts=90\n"


class ClusterCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        command = ROOT / "test" / "fixtures" / "cluster-command.py"
        for name in ("ssh", "squeue", "sacct", "scontrol", "sinfo", "hostname", "klist", "getent"):
            target = self.bin / name
            target.write_text(command.read_text(), encoding="utf-8")
            target.chmod(0o755)
        self.fixture = self.base / "commands.json"
        self.commands = {
            "squeue": {"stdout": JOB},
            "scontrol": {"stdout": NODE},
            "hostname": {"stdout": "compute\n"},
            "sacct": {"stdout": "41|researcher|COMPLETED|00:01:00|2026-10-11T11:00:00|2026-10-11T11:01:00|2026-10-11T11:02:00|finished\n"},
        }
        self.environment = patch.dict(os.environ, fixture_environment(**{
            "HEARTH_BASE_DIR": str(self.base),
            "HEARTH_STATE_DIR": str(self.base / "state"),
            "HEARTH_CONFIG_DIR": str(self.base / "config"),
            "HEARTH_TEST_CLUSTER_FIXTURE": str(self.fixture),
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "HEARTH_CLUSTER_PROBE_HOST": "",
            "HEARTH_CLUSTER_JUMP": "fixture-jump",
        }), clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        spec = importlib.util.spec_from_file_location("cluster_test_agent", ROOT / "pi/dashboard/dashboard_agent.py")
        self.agent = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.agent)
        (self.base / "config/cluster.json").write_text(json.dumps({
            "sshHost": "fixture-compute", "jumpHost": "fixture-jump", "user": "researcher",
        }), encoding="utf-8")

    def collect(self):
        self.fixture.write_text(json.dumps(self.commands), encoding="utf-8")
        return self.agent.cluster_status()

    def test_failed_jobs_do_not_become_empty_when_later_commands_succeed(self):
        self.commands["squeue"] = {"exit": 1, "stderr": "scheduler unavailable\n"}
        result = self.collect()
        self.assertTrue(result["reachable"])
        self.assertEqual(result["queries"]["jobs"]["status"], "failed")
        self.assertIsNone(result["jobs"])
        self.assertTrue(result["accountingAvailable"])
        self.assertEqual(result["terminalJobs"][0]["id"], "41")
        self.assertEqual(result["nodes"][0]["gpu"]["free"], 1)
        self.assertIsNone(result["nodes"][0]["jobs"])

    def test_one_malformed_or_conflicting_job_invalidates_the_complete_jobs_observation(self):
        for invalid in ("truncated|row\n", JOB.replace("researcher", ""),
                        JOB.replace("RUNNING", ""), JOB.replace("42|", "|", 1),
                        JOB.replace("simulation", "conflicting-name")):
            with self.subTest(invalid=invalid):
                self.commands["squeue"] = {"stdout": JOB + invalid}
                result = self.collect()
                self.assertEqual(result["queries"]["jobs"]["status"], "malformed")
                self.assertIsNone(result["jobs"])
                self.assertTrue(result["accountingAvailable"])

    def test_valid_empty_jobs_and_identical_duplicates_are_accepted(self):
        for output, ids in (("", []), (JOB + JOB, ["42"]),
                            (JOB.replace("RUNNING", "FUTURE_STATE").replace("simulation", "name|with|pipes"), ["42"])):
            with self.subTest(output=output):
                self.commands["squeue"] = {"stdout": output}
                result = self.collect()
                self.assertEqual(result["queries"]["jobs"]["status"], "ok")
                self.assertEqual([job["id"] for job in result["jobs"]], ids)

    def test_completed_jobs_and_accounting_survive_a_later_connection_break(self):
        self.commands["interrupt"] = "nodes"
        result = self.collect()
        self.assertTrue(result["reachable"])
        self.assertEqual(result["jobs"][0]["id"], "42")
        self.assertTrue(result["accountingAvailable"])
        self.assertEqual(result["queries"]["nodes"]["status"], "incomplete")
        self.assertEqual(result["queries"]["starts"]["status"], "missing")
        self.assertIsNone(result["nodes"])

    def test_timeout_with_byte_output_keeps_only_completed_queries(self):
        self.commands["interrupt"] = "nodes"
        real_run = subprocess.run

        def timeout_at_boundary(args, **kwargs):
            result = real_run(args, **kwargs)
            if args[0] == "ssh" and "-O" not in args:
                raise subprocess.TimeoutExpired(args, kwargs["timeout"], output=result.stdout.encode())
            return result

        with patch.object(self.agent.subprocess, "run", side_effect=timeout_at_boundary):
            result = self.collect()
        self.assertEqual(result["jobs"][0]["id"], "42")
        self.assertEqual(result["queries"]["nodes"]["status"], "timed_out")
        self.assertIsNone(result["nodes"])

    def test_optional_query_failures_leave_jobs_and_required_health_usable(self):
        for name in ("starts", "getent", "sinfo", "sacct"):
            self.commands[name] = {"exit": 1}
        result = self.collect()
        self.assertEqual(result["jobs"][0]["id"], "42")
        self.assertIsNone(result["jobs"][0]["estimatedStart"])
        self.assertEqual(result["queries"]["passwd"]["status"], "failed")
        self.assertFalse(result["accountingAvailable"])
        slurm = next(check for check in result["health"]["checks"] if check["key"] == "slurm")
        self.assertTrue(slurm["ok"])

    def test_confirmed_remote_response_does_not_wait_for_redundant_access_probes(self):
        self.commands["interrupt"] = "nodes"
        real_run = subprocess.run
        probes = []

        def record_probes(args, **kwargs):
            if args[0] == "klist" or "-O" in args:
                probes.append(args)
            return real_run(args, **kwargs)

        with patch.object(self.agent.subprocess, "run", side_effect=record_probes):
            result = self.collect()
        self.assertTrue(result["reachable"])
        self.assertEqual(probes, [])

    def test_failed_transport_bounds_diagnostics_and_leaves_unobserved_login_unknown(self):
        clock = [100.0]
        probe_timeouts = []

        def unavailable(args, **kwargs):
            if args[0] == "ssh" and "-O" not in args:
                clock[0] += 35
                return subprocess.CompletedProcess(args, 255, "", "connection failed")
            probe_timeouts.append(kwargs["timeout"])
            clock[0] += kwargs["timeout"]
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])

        with patch.object(self.agent.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(self.agent.subprocess, "run", side_effect=unavailable):
            result = self.collect()
        self.assertFalse(result["reachable"])
        self.assertLessEqual(sum(probe_timeouts), 3)
        for check in result["health"]["checks"]:
            if check["key"] in {"ticket", "jump"}:
                self.assertEqual(check["state"], "unknown")

    def test_successful_transport_without_query_evidence_is_not_an_empty_queue(self):
        real_run = subprocess.run

        def empty_transport(args, **kwargs):
            if args[0] == "ssh" and "-O" not in args:
                return subprocess.CompletedProcess(args, 0, "", "")
            return real_run(args, **kwargs)

        with patch.object(self.agent.subprocess, "run", side_effect=empty_transport):
            result = self.collect()
        self.assertFalse(result["reachable"])
        self.assertEqual(result["queries"]["jobs"]["status"], "missing")
        self.assertIsNone(result["jobs"])

    def test_failed_node_command_is_not_masked_by_output_limiting_or_later_queries(self):
        self.commands["scontrol"] = {"stdout": NODE, "exit": 1}
        result = self.collect()
        self.assertEqual(result["jobs"][0]["id"], "42")
        self.assertIsNone(result["nodes"])
        self.assertEqual(result["queries"]["nodes"]["status"], "failed")
        slurm = next(check for check in result["health"]["checks"] if check["key"] == "slurm")
        self.assertEqual(slurm["state"], "degraded")

    def test_malformed_accounting_does_not_discard_valid_jobs(self):
        self.commands["sacct"] = {"stdout": "41|researcher||00:01:00|Unknown|Unknown|Unknown|finished\n"}
        result = self.collect()
        self.assertEqual(result["jobs"][0]["id"], "42")
        self.assertFalse(result["accountingAvailable"])
        self.assertEqual(result["queries"]["accounting"]["status"], "malformed")

    def test_inconclusive_route_timeout_does_not_request_a_vpn_password(self):
        def timed_out(args, **kwargs):
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])

        self.agent.CLUSTER_PROBE_HOST = "fixture.invalid"
        with patch.object(self.agent.subprocess, "run", side_effect=timed_out), \
                patch.object(self.agent.socket, "create_connection", side_effect=socket.timeout):
            result = self.collect()
        vpn = next(check for check in result["health"]["checks"] if check["key"] == "vpn")
        self.assertEqual(vpn["state"], "unknown")


if __name__ == "__main__":
    unittest.main()
