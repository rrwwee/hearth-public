#!/bin/bash
set -euo pipefail
# Refuse a host cgroup namespace: this mount must expose only this container.
test "$(cat /proc/self/cgroup)" = '0::/'
mount -o remount,rw /sys/fs/cgroup
exec /lib/systemd/systemd --unit=multi-user.target
