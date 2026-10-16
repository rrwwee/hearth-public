import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fixture_environment import fixture_environment


TEMP_DIR = tempfile.TemporaryDirectory()
sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).parents[1] / "pi" / "dashboard" / "dashboard_agent.py"
SPEC = importlib.util.spec_from_file_location("dashboard_agent", MODULE_PATH)
dashboard_agent = importlib.util.module_from_spec(SPEC)
with patch.dict(os.environ, fixture_environment(HEARTH_BASE_DIR=TEMP_DIR.name), clear=True):
    SPEC.loader.exec_module(dashboard_agent)


class AccountingParserTests(unittest.TestCase):
    def test_friend_colors_are_loaded_from_private_cluster_config(self):
        config_path = dashboard_agent.CONFIG_DIR / "cluster.json"
        config_path.write_text(json.dumps({
            "sshHost": "compute",
            "jumpHost": "cluster-jump",
            "user": "researcher",
            "friends": ["researcher", "collaborator"],
            "friendColors": {"researcher": "red", "collaborator": "blue"},
        }), encoding="utf-8")

        config = dashboard_agent.load_cluster_config()

        self.assertEqual(config["friendColors"], {"researcher": "red", "collaborator": "blue"})

    def test_unavailable_accounting_is_explicit(self):
        self.assertEqual(dashboard_agent.parse_accounting(["__UNAVAILABLE__"]), (False, []))

    def test_terminal_rows_are_parsed_and_nonterminal_rows_ignored(self):
        available, jobs = dashboard_agent.parse_accounting([
            "__AVAILABLE__",
            "420|researcher|COMPLETED|00:02:00|2026-07-21T10:00:00|2026-07-21T10:01:00|2026-07-21T10:03:00|good-job",
            "421|researcher|OUT_OF_MEMORY+|00:01:00|2026-07-21T10:00:00|2026-07-21T10:01:00|2026-07-21T10:02:00|large-job",
            "422|researcher|RUNNING|00:00:10|2026-07-21T10:00:00|2026-07-21T10:01:00|Unknown|live-job",
        ])

        self.assertTrue(available)
        self.assertEqual([job["id"] for job in jobs], ["420", "421"])
        self.assertEqual(jobs[1]["state"], "OUT_OF_MEMORY")
        self.assertEqual(jobs[0]["name"], "good-job")
        self.assertEqual(jobs[0]["startedAt"], "2026-07-21T10:01:00")


class DeviceLabelTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = Path(self.directory.name)
        self.patch = patch.object(dashboard_agent, "CONFIG_DIR", self.config)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_missing_device_labels_are_empty_without_creating_a_file(self):
        self.assertEqual(dashboard_agent.load_device_names(), {})
        self.assertEqual(list(self.config.iterdir()), [])

    def test_invalid_configuration_is_reported_without_replacement(self):
        path = self.config / "devices.json"
        for raw in ["{broken", "null", "[]", "{}", '{"devices":null}',
                    '{"devices":[]}', '{"devices":{"name":7}}',
                    '{"devices":{},"extra":NaN}', '{"devices":{},"extra":Infinity}']:
            with self.subTest(raw=raw):
                path.write_text(raw, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Device configuration"):
                    dashboard_agent.load_device_names()
                self.assertEqual(path.read_text(encoding="utf-8"), raw)

    def test_unreadable_configuration_is_not_treated_as_missing(self):
        with patch.object(Path, "read_text", side_effect=PermissionError("permission denied")):
            with self.assertRaises(PermissionError):
                dashboard_agent.load_device_names()
        self.assertEqual(list(self.config.iterdir()), [])

    def test_existing_strings_and_ip_before_mac_naming_are_preserved(self):
        mac = ":".join(["02", "00", "00", "00", "00", "ab"])
        labels = {"192.0.2.10": "IP label", mac: "MAC label", "empty": "", "long": "x" * 100}
        (self.config / "devices.json").write_text(json.dumps({"devices": labels, "extra": True}), encoding="utf-8")
        self.assertEqual(dashboard_agent.load_device_names(), labels)
        devices = dashboard_agent.apply_device_names([{"ip": "192.0.2.10", "mac": mac.upper()}])
        self.assertEqual(devices[0]["nickname"], "IP label")

    def test_fresh_network_cache_still_skips_label_loading(self):
        (self.config / "devices.json").write_text("{broken", encoding="utf-8")
        cached = {"timestamp": 1000, "devices": []}
        (self.config / "network-cache.json").write_text(json.dumps(cached), encoding="utf-8")
        with patch.object(dashboard_agent, "STATE_DIR", self.config), patch.object(dashboard_agent.time, "time", return_value=1001):
            self.assertEqual(dashboard_agent.network_scan(), cached)


if __name__ == "__main__":
    unittest.main()
