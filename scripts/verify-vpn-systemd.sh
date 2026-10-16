#!/usr/bin/env bash
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/hearth-systemd.XXXXXX")"
name="hearth-systemd-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
image="$name:local"
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    docker logs "$name" >&2 || true
  fi
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Send only selected source files and synthetic fixtures to the Docker daemon.
cp "$repo/test/vpn-systemd/"* "$work/"
mkdir -p "$work/source/pi/dashboard/lib"
cp "$repo/pi/dashboard/lib/"{vpn,config}.sh "$work/source/pi/dashboard/lib/"
cp "$repo/pi/dashboard/"{start-vpn-from-stdin,start-uoe-vpn-from-stdin}.sh "$work/source/pi/dashboard/"
docker build --quiet --tag "$image" "$work" >/dev/null

# The unprivileged container user must traverse this synthetic fixture mount.
# Linux bind mounts retain the host mktemp directory's owner and mode.
chmod 755 "$work"

# Private PID/network/cgroup namespaces. No Docker socket, host devices, or
# writable host mounts. Permit PID 1 to mount its private cgroup hierarchy.
docker run --detach --name "$name" --network none --cgroupns private \
  --cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --memory 512m --cpus 2 --pids-limit 256 \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  --mount "type=bind,source=$work,target=/check,readonly" \
  "$image" /bin/bash /check/boot.sh >/dev/null

for ((attempt = 0; attempt < 100; attempt++)); do
  if docker exec "$name" systemctl show --property=Version >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
docker exec "$name" /bin/bash /check/setup.sh
docker exec --user user --env XDG_RUNTIME_DIR=/run/user/1000 \
  "$name" python3 /check/verify.py
