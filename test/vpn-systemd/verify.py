#!/usr/bin/python3
import json, os, pathlib, signal, subprocess, time
root=pathlib.Path('/home/user/verification')
source=pathlib.Path('/opt/hearth/pi/dashboard')
env=dict(os.environ,HOME='/home/user',XDG_RUNTIME_DIR='/run/user/1000',HEARTH_ENV_FILE=str(root/'absent'),HEARTH_STATE_DIR=str(root/'state'),TMPDIR=str(root/'tmp'),HEARTH_VPN_HOST='vpn.example.invalid',HEARTH_VPN_PORT='443',HEARTH_VPN_USER='fixture researcher',HEARTH_VPN_TRUSTED_CERT='a'*64)
secret=(root/'expected-secret').read_text()
def run(*args,check=True,**kw):
    p=subprocess.run(args,env=env,capture_output=True,text=True,timeout=15,**kw)
    if check: assert p.returncode==0,(args,p.returncode,p.stdout,p.stderr)
    return p
def ctl(*args,check=True): return run('systemctl','--user',*args,check=check)
def launch(name='start-vpn-from-stdin.sh'):
    return run('/bin/bash',str(source/name),input=secret+'\n',check=False)
def pid(unit='hearth-vpn.service'):
    return int(ctl('show','--property=MainPID','--value',unit).stdout.strip())
def records():
    return [json.loads(x) for x in (root/'commands.jsonl').read_text().splitlines()]
def vpns(): return [x for x in records() if x['command']=='openfortivpn' and x.get('event')=='started']
def mode(**values): (root/'mode.json').write_text(json.dumps(values))
def no_secret_leak():
    for p in pathlib.Path('/proc').glob('[0-9]*'):
        for name in ['cmdline','environ']:
            try: data=(p/name).read_bytes()
            except (PermissionError,ProcessLookupError,FileNotFoundError): continue
            assert secret.encode() not in data,(str(p),name)
    for p in (root/'state').glob('*'):
        if p.is_file(): assert secret not in p.read_text(),str(p)
    assert not list((root/'tmp').iterdir())
def wait_until(fn):
    for i in range(100):
        if fn(): return
        time.sleep(.05)
    raise AssertionError('condition timed out')
print('systemd:',run('systemctl','--version').stdout.splitlines()[0],flush=True)
print('kernel:',run('uname','-m').stdout.strip(),flush=True)
p=launch()
assert p.returncode==0,(p.returncode,p.stdout,p.stderr)
assert ctl('is-active','hearth-vpn.service').stdout.strip()=='active'
assert vpns()[-1]['passwordMatches'] and not vpns()[-1]['secretInEnvironment']
assert vpns()[-1]['uid']==0 and not vpns()[-1]['stdinIsTTY']
assert '--trusted-cert='+'a'*64 in vpns()[-1]['args']
no_secret_leak()
print('PASS: canonical startup, real sudo from detached worker, private stdin, certificate, secret cleanup',flush=True)
first_pid=pid()
for name in ['start-uoe-vpn-from-stdin.sh','start-vpn-from-stdin.sh']:
    p=launch(name)
    assert p.returncode==0,(p.returncode,p.stdout,p.stderr)
    assert pid()!=first_pid
    no_secret_leak()
    first_pid=pid()
print('PASS: both launcher paths reconnect through collected transient units',flush=True)
ctl('stop','hearth-vpn.service')

def absent(unit='hearth-vpn.service'):
    return ctl('show','--property=LoadState','--value',unit).stdout.strip()=='not-found'
def dead(process): return not pathlib.Path('/proc',str(process)).exists()
def all_vpns_dead(): return all(dead(x['pid']) for x in vpns())
def stop():
    ctl('stop','hearth-vpn.service',check=False)
    wait_until(all_vpns_dead)
    no_secret_leak()
def begin(name='start-vpn-from-stdin.sh',new_session=False):
    p=subprocess.Popen(['/bin/bash',str(source/name)],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=new_session)
    p.stdin.write(secret+'\n');p.stdin.close();p.stdin=None
    return p

# Start a genuine transient legacy process alongside the canonical process.
p=launch();assert p.returncode==0,(p.returncode,p.stderr)
legacy=run('systemd-run','--user','--unit=hearth-uoe-vpn','--collect','--','/bin/sleep','infinity')
legacy_pid=pid('hearth-uoe-vpn.service'); old=vpns()[-1]['pid']
p=launch('start-uoe-vpn-from-stdin.sh');assert p.returncode==0,p.stderr
wait_until(lambda:dead(legacy_pid) and dead(old))
assert absent('hearth-uoe-vpn.service')
print('PASS: migration stops real legacy and canonical processes before replacement',flush=True)

# Route rejection must not stop or replace the running process.
old=vpns()[-1]['pid'];launches=len(vpns());mode(route_failure=True)
p=launch();assert p.returncode!=0 and 'existing VPN left running' in p.stderr,p.stderr
assert len(vpns())==launches and not dead(old)
assert ctl('is-active','hearth-vpn.service').stdout.strip()=='active'
mode();no_secret_leak()
print('PASS: failed physical-route verification preserves the existing live process',flush=True)

# Keep the password-free process alive until explicit teardown.
time.sleep(3)
assert not dead(old) and ctl('is-active','hearth-vpn.service').stdout.strip()=='active'
print('PASS: successful helper exit leaves the managed VPN process running',flush=True)

# Match the dashboard's cancellation scope while DNS is blocked. The existing
# systemd-owned VPN is outside the helper group and must remain alive.
mode(block_dns=True)
p=begin(new_session=True)
try:
    wait_until(lambda:any(x['command']=='getent' and x.get('event')=='blocked' for x in records()))
    lookup=next(x['pid'] for x in reversed(records()) if x['command']=='getent' and x.get('event')=='blocked')
    os.killpg(p.pid,signal.SIGTERM)
    stdout,stderr=p.communicate(timeout=3)
    assert p.returncode==143,(p.returncode,stdout,stderr)
    wait_until(lambda:dead(lookup))
    assert not dead(old) and ctl('is-active','hearth-vpn.service').stdout.strip()=='active'
    no_secret_leak()
finally:
    if p.poll() is None:
        os.killpg(p.pid,signal.SIGKILL);p.communicate(timeout=3)
    mode()
p=launch();assert p.returncode==0,p.stderr
print('PASS: cancelling a blocked lookup reaps its child, preserves the old VPN, and permits retry',flush=True)

# User-controlled argument values must survive systemd's ExecStart parser.
original_user=env['HEARTH_VPN_USER']; env['HEARTH_VPN_USER']='fixture $HOME ${HOME} %h @user'
original_cert=env.pop('HEARTH_VPN_TRUSTED_CERT')
p=launch();assert p.returncode==0,p.stderr
assert vpns()[-1]['args'][2]==env['HEARTH_VPN_USER'],vpns()[-1]['args']
assert not any(arg.startswith('--trusted-cert') for arg in vpns()[-1]['args'])
env['HEARTH_VPN_USER']=original_user;env['HEARTH_VPN_TRUSTED_CERT']=original_cert
print('PASS: dollar/percent/space argument fidelity and omitted optional certificate',flush=True)

# The same flock protects both compatibility entrypoints.
count=len(vpns());p=begin('start-uoe-vpn-from-stdin.sh')
wait_until(lambda:len(vpns())>count)
q=launch();assert q.returncode==75 and 'already in progress' in q.stderr,q.stderr
stdout,stderr=p.communicate(timeout=10);assert p.returncode==0,(stdout,stderr)
assert len(vpns())==count+1
print('PASS: real flock rejects overlapping callers across both launchers',flush=True)

# A failed subprocess must not survive as an inactive or retrying unit.
mode(startup_failure=True);p=launch()
assert p.returncode!=0 and 'failed to start' in p.stderr,(p.returncode,p.stderr)
wait_until(all_vpns_dead);assert absent();no_secret_leak();mode()
print('PASS: startup failure reaps processes, collects the unit, and removes FIFO state',flush=True)

# Hold the real unit in ExecStartPre so the FIFO has no reader.
dropin=pathlib.Path('/home/user/.config/systemd/user/hearth-vpn.service.d/verify.conf')
dropin.parent.mkdir(parents=True,exist_ok=True)
dropin.write_text('[Service]\nExecStartPre=/bin/sleep 10\n')
ctl('daemon-reload')
try:
    count=len(vpns());p=begin()
    wait_until(lambda: bool(list((root/'tmp').glob('hearth-vpn-pass.*/password'))))
    fifo=next((root/'tmp').glob('hearth-vpn-pass.*/password'))
    assert fifo.stat().st_mode & 0o777 == 0o600
    assert fifo.parent.stat().st_mode & 0o777 == 0o700
    stdout,stderr=p.communicate(timeout=10)
    assert p.returncode!=0 and 'startup deadline' in stderr,(p.returncode,stderr)
    assert len(vpns())==count and absent();no_secret_leak()
finally:
    dropin.unlink();ctl('daemon-reload')
print('PASS: unread FIFO deadline stops a real activating service and cleans private files',flush=True)

# Cancellation while the worker is live must kill the complete service cgroup.
count=len(vpns());p=begin();wait_until(lambda:len(vpns())>count)
p.terminate();stdout,stderr=p.communicate(timeout=10)
assert p.returncode==143,(p.returncode,stdout,stderr)
wait_until(all_vpns_dead);assert absent();no_secret_leak()
p=launch();assert p.returncode==0,p.stderr
print('PASS: cancellation kills the service cgroup and releases the lock for retry',flush=True)

# The dashboard escalates after a second. Private startup files must already
# be gone even if systemd is still completing a slower worker shutdown.
dropin.write_text('[Service]\nExecStopPost=/bin/sleep 2\n')
ctl('daemon-reload')
mode(slow_stop=True)
count=len(vpns());p=begin(new_session=True)
try:
    wait_until(lambda:len(vpns())>count)
    os.killpg(p.pid,signal.SIGTERM)
    time.sleep(1)
    if p.poll() is None: os.killpg(p.pid,signal.SIGKILL)
    p.communicate(timeout=3)
    assert not list((root/'tmp').iterdir()),'forced cancellation left private startup files'
    wait_until(lambda:all_vpns_dead() and absent());no_secret_leak()
finally:
    if p.poll() is None:
        os.killpg(p.pid,signal.SIGKILL);p.communicate(timeout=3)
    mode()
    dropin.unlink();ctl('daemon-reload')
p=launch();assert p.returncode==0,p.stderr
print('PASS: forced cancellation removes private files during slow systemd shutdown and permits retry',flush=True)

# A loose legacy wrapper must find the current release instead of sourcing root hooks.
import shutil
release=root/'deployment/current/pi/dashboard';release.mkdir(parents=True,exist_ok=True)
(release/'lib').symlink_to(source/'lib',target_is_directory=True)
loose=root/'start-uoe-vpn-from-stdin.sh';shutil.copy2(source/'start-uoe-vpn-from-stdin.sh',loose)
env['HEARTH_BASE_DIR']=str(root/'deployment')
p=run('/bin/bash',str(loose),input=secret+'\n',check=False)
assert p.returncode==0,p.stderr;no_secret_leak();stop()
print('PASS: deployed loose UOE wrapper resolves the current shared release',flush=True)
print('PASS: all real-systemd lifecycle scenarios; no managed or fixture processes left running',flush=True)
