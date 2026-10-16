import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

adapter_path = Path("test/fixtures/vpn-command.py")
if adapter_path.exists():
    adapter = adapter_path.read_text()
else:
    source = Path("test/vpn-lifecycle.test.js").read_text()
    adapter = source.split("const adapter = String.raw`", 1)[1].split("`;", 1)[0]
env = {k: v for k, v in os.environ.items() if not k.startswith(("HEARTH_", "GIT_")) and k != "PORT"}
env["PYTHONDONTWRITEBYTECODE"] = "1"
with tempfile.TemporaryDirectory(prefix="hearth-issue21-adapter-") as directory:
    root = Path(directory)
    path = root / "adapter"
    path.write_text(adapter)
    path.chmod(0o755)
    for name in ("getent", "systemctl", "sleep"):
        (root / name).symlink_to(path)
    env["VPN_TEST_ROOT"] = str(root)
    cases = {
        "shell-launch": ["sh", "-c", ":"],
        "python-pass": ["python3", "-c", "pass"],
        "python-no-site-pass": ["python3", "-S", "-c", "pass"],
        "python-core-imports": ["python3", "-c", "import fcntl, json, os, pathlib, sys, time"],
        "python-adapter-imports": ["python3", "-c", "import fcntl, json, os, pathlib, re, subprocess, sys, time"],
        "getent-adapter": [str(root / "getent"), "ahostsv4", "vpn.example.invalid"],
        "systemctl-show-adapter": [str(root / "systemctl"), "--user", "show", "hearth-vpn.service", "--property=LoadState", "--value"],
        "sleep-zero-adapter": [str(root / "sleep"), "0"],
        "sleep-capped-adapter": [str(root / "sleep"), "0.05"],
    }
    timings = {name: [] for name in cases}
    for i in range(30):
        for name, command in cases.items():
            start = time.perf_counter()
            subprocess.run(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=30)
            timings[name].append((time.perf_counter() - start) * 1000)
    print(json.dumps({"samples_ms": timings, "summary_ms": {name: {"min": min(values), "median": statistics.median(values), "max": max(values)} for name, values in timings.items()}}, indent=2))
