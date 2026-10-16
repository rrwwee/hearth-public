#!/bin/bash
set -euo pipefail
mkdir -p /home/user/verification/state /home/user/verification/tmp
printf '{}\n' > /home/user/verification/mode.json
printf '%s' 'synthetic-systemd-password' > /home/user/verification/expected-secret
: > /home/user/verification/commands.jsonl
chmod 600 /home/user/verification/{expected-secret,commands.jsonl}
chown -R user:user /home/user/verification
install -m 755 /check/fixture.py /usr/local/bin/hearth-vpn-fixture
for name in getent ip openfortivpn; do ln -sf hearth-vpn-fixture /usr/local/bin/$name; done
printf '%s\n' 'Defaults secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' 'user ALL=(root) NOPASSWD: /usr/local/bin/ip, /usr/local/bin/openfortivpn' > /etc/sudoers.d/hearth-verification
chmod 440 /etc/sudoers.d/hearth-verification
visudo --check --file=/etc/sudoers.d/hearth-verification
systemctl start user@1000.service
