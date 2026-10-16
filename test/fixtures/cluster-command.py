#!/usr/bin/env python3
"""Local command substitutes for cluster collector integration tests."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["HEARTH_TEST_CLUSTER_FIXTURE"], encoding="utf-8") as source:
    fixture = json.load(source)
if name == "ssh":
    if "-O" in args:
        sys.exit(0)
    command = args[-1]
    if command.startswith("ssh "):
        sys.exit(subprocess.call(shlex.split(command)))
    interrupt = fixture.get("interrupt")
    if interrupt:
        child = subprocess.Popen(["/bin/sh", "-c", command], stdout=subprocess.PIPE, text=True)
        for line in child.stdout:
            print(line, end="", flush=True)
            if f" BEGIN {interrupt}" in line:
                child.terminate()
                child.wait()
                sys.exit(255)
        sys.exit(child.wait())
    sys.exit(subprocess.call(["/bin/sh", "-c", command]))

if name == "squeue" and "--start" in args:
    name = "starts"
elif name == "squeue" and "%u" in args:
    name = "usernames"

behavior = fixture.get(name, {})
print(behavior.get("stdout", ""), end="", flush=True)
time.sleep(behavior.get("delay", 0))
print(behavior.get("stderr", ""), end="", file=sys.stderr, flush=True)
sys.exit(behavior.get("exit", 0))
