#!/usr/bin/env bash
set -euo pipefail

# Only remount the container's private cgroup hierarchy.
test "$(cat /proc/self/cgroup)" = '0::/'
mount -o remount,rw /sys/fs/cgroup
exec /lib/systemd/systemd --unit=multi-user.target
