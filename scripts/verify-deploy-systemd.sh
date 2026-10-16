#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
container="hearth-deploy-check-$$"
image="$container:local"
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    docker logs "$container" >&2 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build --quiet -f "$root/test/deploy-systemd/Dockerfile" -t "$image" "$root"
# No host directories, sockets, ports, or cgroups are mounted into this host.
docker run -d --name "$container" --network none --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --memory 768m --cpus 2 --pids-limit 256 \
  --cgroupns private --tmpfs /run --tmpfs /run/lock "$image" >/dev/null
for _attempt in $(seq 1 30); do
  if docker exec "$container" systemctl show --property=Version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" python3 /opt/hearth/verify.py
