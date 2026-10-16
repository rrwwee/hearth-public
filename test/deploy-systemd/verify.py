"""Exercise the real deployment CLI inside a disposable, offline systemd host."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(*args, check=True, env=None):
    result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=120)
    if check and result.returncode:
        print(result.stdout, result.stderr)
        raise RuntimeError(f"Command failed: {args}")
    return result


run("systemctl", "start", "user@0.service")
os.environ["XDG_RUNTIME_DIR"] = "/run/user/0"
os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/0/bus"
root = Path(tempfile.mkdtemp(prefix="hearth-systemd-"))
source = root / "source"
source.mkdir()
shutil.copytree("/opt/hearth/pi", source / "pi")
(source / "public").mkdir()
(source / "package.json").write_text(json.dumps({"scripts": {"check:syntax": "node --check server.js", "test": "node --test"}}))
server = """const http = require('node:http');
if (process.env.HEARTH_VALIDATE_ONLY === '1') process.exit(0);
const log = text => require('node:fs').appendFileSync('/tmp/hearth-fixture-server.log', text+'\\n');
log(JSON.stringify({port:process.env.PORT,release:process.env.HEARTH_RELEASE}));
process.on('uncaughtException', error => { log(error.stack); process.exit(1); });
BROKEN
http.createServer((req,res) => {
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({ok:true,mode:'live',release:process.env.HEARTH_RELEASE||'development'}));
}).listen(Number(process.env.PORT), '127.0.0.1');
"""
(source / "server.js").write_text(server.replace("BROKEN", ""))
run("git", "init", str(source))
run("git", "-C", str(source), "config", "user.email", "fixture@example.invalid")
run("git", "-C", str(source), "config", "user.name", "Fixture")
run("git", "-C", str(source), "add", ".")
run("git", "-C", str(source), "commit", "-m", "Initial fixture release")
old = run("git", "-C", str(source), "rev-parse", "HEAD").stdout.strip()
installation = root / "installation"
(installation / "config").mkdir(parents=True)
private = installation / "config/hearth.env"
private.write_text('PORT=4197\nPRIVATE_SETTING="preserved value"\nHEARTH_RELEASE=private-file-old-identity\n')
env = dict(os.environ, HEARTH_BASE_DIR=str(installation), HEARTH_REPOSITORY_URL=str(source),
           HEARTH_SYSTEMD_USER_DIR="/root/.config/systemd/user")
launcher = "/opt/hearth/pi/dashboard/deploy-from-git.sh"


def deploy(revision, success=True):
    result = run("bash", launcher, revision, env=env, check=False)
    print(result.stdout, end="")
    print(result.stderr, end="")
    if (result.returncode == 0) != success:
        journal = run("journalctl", "--user", "-u", "dashboard-hearth-web.service", "--no-pager", "-n", "30", check=False)
        print(journal.stdout, journal.stderr)
        log = Path("/tmp/hearth-fixture-server.log")
        if log.exists():
            print(log.read_text())
    assert (result.returncode == 0) == success, f"deployment exited {result.returncode}"


def state(property_name):
    return run("systemctl", "--user", "show", "dashboard-hearth-web.service", "--property=" + property_name, "--value").stdout.strip()


def make_release(broken=False):
    (source / "server.js").write_text(server.replace("BROKEN", "process.exit(1);" if broken else "// next release"))
    run("git", "-C", str(source), "add", ".")
    run("git", "-C", str(source), "commit", "-m", "Broken fixture" if broken else "Next fixture")
    return run("git", "-C", str(source), "rev-parse", "HEAD").stdout.strip()


deploy(old)
assert state("UnitFileState") == "enabled"
assert state("ActiveState") == "active"
run("systemctl", "--user", "disable", "dashboard-hearth-web.service")
unit = Path("/root/.config/systemd/user/dashboard-hearth-web.service")
unit_contents = unit.read_bytes()
next_release = make_release()
deploy(next_release)
assert state("UnitFileState") == "disabled"
assert unit.read_bytes() == unit_contents
pid = state("MainPID")
assert b"PRIVATE_SETTING=preserved value" in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
run("systemctl", "--user", "stop", "dashboard-hearth-web.service")
deploy(old)
assert state("ActiveState") == "inactive"
run("systemctl", "--user", "start", "dashboard-hearth-web.service")
broken = make_release(broken=True)
deploy(broken, success=False)
assert (installation / "current").resolve().name == old
assert state("ActiveState") == "active"
assert state("UnitFileState") == "disabled"
assert unit.read_bytes() == unit_contents
assert not (installation / "state/deploy-recovery").exists()
health = json.loads(run("curl", "--silent", "--fail", "http://127.0.0.1:4197/api/health").stdout)
assert health["release"] == old
print("Real-systemd deployment verification passed.")
