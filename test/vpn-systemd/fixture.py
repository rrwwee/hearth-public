#!/usr/bin/python3
import json, os, pathlib, signal, sys, time
root = pathlib.Path('/home/user/verification')
mode = json.loads((root/'mode.json').read_text())
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
def record(**values):
    data = dict(command=name, args=args, pid=os.getpid(), **values)
    fd=os.open(root/'commands.jsonl', os.O_WRONLY | os.O_APPEND)
    os.write(fd,(json.dumps(data)+'\n').encode()); os.close(fd)
if name == 'getent':
    if args[:1] != ['ahostsv4']: os.execv('/usr/bin/getent',['/usr/bin/getent']+args)
    if mode.get('block_dns'):
        record(event='blocked')
        time.sleep(30)
    print('203.0.113.8 STREAM vpn.example.invalid')
elif name == 'ip':
    record()
    if 'default' in args:
        print('default via 192.0.2.1 dev eth0 metric 100')
        print('default via 192.0.2.2 dev wlan0 metric 600')
    elif 'replace' in args:
        sys.exit(1 if mode.get('route_failure') else 0)
    elif 'get' in args:
        device='wrong0' if mode.get('route_failure') else 'eth0'
        print('203.0.113.8 via 192.0.2.1 dev '+device+' src 192.0.2.10')
    else: sys.exit(99)
elif name == 'openfortivpn':
    secret=sys.stdin.readline().rstrip('\n')
    record(event='started',passwordMatches=secret==(root/'expected-secret').read_text(),
           secretInEnvironment=any(secret in v for v in os.environ.values()), uid=os.getuid(),
           stdinIsTTY=sys.stdin.isatty())
    if mode.get('startup_failure'): sys.exit(42)
    def stopped(signum, frame):
        if mode.get('slow_stop'): time.sleep(2)
        record(event='stopped',signal=signum)
        sys.exit(0)
    signal.signal(signal.SIGTERM,stopped)
    signal.signal(signal.SIGINT,stopped)
    while True: signal.pause()
else: sys.exit(99)
