"""Assemble the small, real-runtime candidate used by deployment validation tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
from fixture_environment import fixture_environment


SOURCE_TREES = ("lib", "demo", "public", "pi/dashboard")
SOURCE_EXTENSIONS = {".js", ".mjs", ".cjs", ".py", ".sh", ".html", ".css"}
GENERATED_DIRECTORIES = {"node_modules", "__pycache__", "coverage", "dist", "build",
                         "state", "tmp", "temp", "scratch"}


def _candidate_source_paths(source, env):
    """Select non-ignored source and example config, never local installation data."""
    paths = subprocess.check_output(
        ["git", "-C", str(source), "ls-files", "--cached", "--others", "--exclude-standard", "-z",
         "--", "server.js", *SOURCE_TREES], env=env)
    # --exclude-standard only filters untracked files. Apply ignore rules to
    # tracked files too, so accidentally committed local material stays out.
    ignored = subprocess.run(
        ["git", "-C", str(source), "check-ignore", "--no-index", "--stdin", "-z"],
        input=paths, env=env, capture_output=True)
    if ignored.returncode not in (0, 1):
        ignored.check_returncode()
    for raw in sorted(set(paths.split(b"\0")) - set(ignored.stdout.split(b"\0")) - {b""}):
        relative = Path(os.fsdecode(raw))
        if any(part.startswith(".") or part in GENERATED_DIRECTORIES for part in relative.parts):
            continue
        if relative.is_relative_to("pi/dashboard/config"):
            if not (relative.name.endswith(".example") or ".example." in relative.name):
                continue
        elif relative.suffix not in SOURCE_EXTENSIONS:
            continue
        # Do not follow a source symlink to private files or another tree.
        if any((source / parent).is_symlink() for parent in (relative, *relative.parents)):
            continue
        if (source / relative).is_file():
            yield relative


def assemble_validation_candidate(source, destination):
    """Commit current source contents, with only the selected candidate tests."""
    source, destination = Path(source), Path(destination)
    destination.mkdir()
    env = fixture_environment()
    for relative in _candidate_source_paths(source, env):
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target)

    tests = destination / "test"
    tests.mkdir()
    for name in ("test_dashboard_agent.py", "fixture_environment.py"):
        shutil.copy2(source / "test" / name, tests / name)
    (tests / "validation.test.js").write_text('''import test from "node:test";
import assert from "node:assert/strict";
test("candidate tests have no installation settings", () => {
  assert.deepEqual(Object.keys(process.env).filter(key => key.startsWith("HEARTH_") || key === "PORT"), []);
});
''')
    (destination / "check-validation-input.cjs").write_text(
        'require("node:assert/strict").equal(require("node:fs").readFileSync(0, "utf8"), "");\n')
    (destination / "package.json").write_text(json.dumps({
        "name": "hearth-validation-fixture", "private": True, "type": "module",
        "scripts": {"check:syntax": "node --check server.js",
                    "test": "node check-validation-input.cjs && node --test test/validation.test.js && python3 -B -m unittest discover -s test -p 'test_*.py'"},
    }))

    def git(*args):
        return subprocess.check_output(
            ["git", "-C", str(destination), "-c", "core.hooksPath=/dev/null", *args], env=env, text=True)

    git("init", "-q")
    git("add", "--all")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com",
        "commit", "-qm", "Candidate with real validation")
    return git("rev-parse", "HEAD").strip()
