#!/usr/bin/env bash
set -euo pipefail
umask 077

# Execute the resolved release file directly, without an inline shell command.
if [ "${1:-}" = "--worker" ]; then
  shift
  fifo="$1"
  log="$2"
  host="$3"
  port="$4"
  user="$5"
  trusted_cert="$6"
  IFS= read -r password < "$fifo"
  rm -f -- "$fifo"
  vpn_args=("$host:$port" -u "$user")
  if [ -n "$trusted_cert" ]; then
    vpn_args+=("--trusted-cert=$trusted_cert")
  fi
  exec sudo -n openfortivpn "${vpn_args[@]}" \
    --set-routes=0 --set-dns=0 --pppd-use-peerdns=0 \
    --pppd-ipparam=hearth-vpn --pppd-log="$log.pppd" --persistent=30 \
    >> "$log" 2>&1 <<< "$password"
  exit
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=config.sh
source "$script_dir/config.sh"
hearth_load_config
hearth_require HEARTH_VPN_HOST HEARTH_VPN_PORT HEARTH_VPN_USER HEARTH_STATE_DIR

# Consume stdin even for a busy attempt, so callers can safely write once.
# The password remains a shell variable, never an argument or export.
IFS= read -r vpn_password
if [ -z "$vpn_password" ]; then
  echo "VPN password is required." >&2
  exit 1
fi
# Both interactive shells and user services use the same lock, even when only
# one of them has XDG_RUNTIME_DIR in its environment.
runtime_dir="$HOME/.cache/hearth"
mkdir -p "$runtime_dir"
exec 9>"$runtime_dir/vpn.lock"
if ! flock -n 9; then
  echo "VPN connection attempt already in progress." >&2
  exit 75
fi

state_dir="$HEARTH_STATE_DIR"
log="$state_dir/vpn.log"
event_log="$state_dir/hearth-events.jsonl"
trace_id="${HEARTH_TRACE_ID:-manual-$(date +%s)}"
fifo_dir=""
writer_pid=""
attempt_started=false
attempt_ready=false
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  # Remove private startup files before waiting on child or systemd shutdown.
  # The caller may force termination if either shutdown exceeds its grace period.
  if [ -n "$fifo_dir" ]; then rm -rf -- "$fifo_dir"; fi
  if [ -n "$writer_pid" ]; then
    kill "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
  fi
  if [ "$attempt_started" = true ] && [ "$attempt_ready" = false ]; then
    systemctl --user stop hearth-vpn.service >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
mkdir -p "$state_dir"
log_event() {
  python3 - "$event_log" "$trace_id" "$1" "${2:-}" <<'PY' || true
import json
import os
import sys
from datetime import datetime, timezone
path, trace_id, event, detail = sys.argv[1:]
record = {"ts": datetime.now(timezone.utc).isoformat(), "pid": os.getpid(),
          "source": "vpn-helper", "traceId": trace_id, "event": event}
if detail:
    record["detail"] = detail[:1200]
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, separators=(",", ":")) + "\n")
PY
}

log_event "vpn.start"
vpn_gateway="$(getent ahostsv4 "$HEARTH_VPN_HOST" | awk 'NR == 1 { print $1 }')" || vpn_gateway=""
# Drain all routes: head can SIGPIPE the producer under pipefail.
default_route="$(ip route show default 0.0.0.0/0 | sed -n '1p')" || default_route=""
default_dev="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1) }' <<<"$default_route")"
default_via="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "via") print $(i + 1) }' <<<"$default_route")"
if [ -z "$vpn_gateway" ] || [ -z "$default_dev" ]; then
  echo "Cannot determine the physical VPN gateway route; existing VPN left running." >&2
  exit 1
fi
route_args=("$vpn_gateway/32")
if [ -n "$default_via" ]; then route_args+=(via "$default_via"); fi
route_args+=(dev "$default_dev")
# A denied replacement is harmless only if the required route already exists.
sudo -n ip route replace "${route_args[@]}" 2>/dev/null || true
gateway_route="$(ip -4 route get "$vpn_gateway")" || gateway_route=""
gateway_dev="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1) }' <<<"$gateway_route")"
gateway_via="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "via") print $(i + 1) }' <<<"$gateway_route")"
if [ "$gateway_dev" != "$default_dev" ] || [ "$gateway_via" != "$default_via" ]; then
  log_event "vpn.gateway_route_error"
  echo "Cannot establish or verify the physical VPN gateway route; existing VPN left running." >&2
  exit 1
fi

for unit in hearth-uoe-vpn.service hearth-vpn.service; do
  load_state="$(systemctl --user show --property=LoadState --value "$unit")"
  if [ "$load_state" != "not-found" ]; then
    for action in stop reset-failed; do
      if ! systemctl --user "$action" "$unit"; then
        # --collect units can disappear between any two systemctl calls.
        # Only verified absence makes a failed cleanup command harmless.
        load_state="$(systemctl --user show --property=LoadState --value "$unit")"
        if [ "$load_state" != "not-found" ]; then
          echo "Cannot $action $unit; refusing to start another VPN." >&2
          exit 1
        fi
      fi
    done
    # A completed stop can precede collection of the transient unit's name.
    for ((attempt = 0; attempt < 40; attempt++)); do
      load_state="$(systemctl --user show --property=LoadState --value "$unit")"
      if [ "$load_state" = "not-found" ]; then break; fi
      sleep 0.05
    done
    if [ "$load_state" != "not-found" ]; then
      echo "Cannot release $unit; refusing to start another VPN." >&2
      exit 1
    fi
  fi
done

fifo_dir="$(mktemp -d "${TMPDIR:-/tmp}/hearth-vpn-pass.XXXXXX")"
fifo="$fifo_dir/password"
mkfifo -m 600 "$fifo"
worker_args=("$script_dir/vpn.sh" --worker "$fifo" "$log" "$HEARTH_VPN_HOST" "$HEARTH_VPN_PORT" "$HEARTH_VPN_USER" "${HEARTH_VPN_TRUSTED_CERT:-}")
# systemd expands dollars in ExecStart arguments, even without an inline shell.
for index in "${!worker_args[@]}"; do
  worker_args[$index]="${worker_args[$index]//\$/\$\$}"
done
attempt_started=true
systemd-run --user --unit=hearth-vpn --collect --no-block -- \
  /bin/bash "${worker_args[@]}" 9>&- >/dev/null

(printf '%s\n' "$vpn_password" > "$fifo") &
writer_pid=$!
unset vpn_password
for ((attempt = 0; attempt < 40; attempt++)); do
  if ! kill -0 "$writer_pid" 2>/dev/null; then break; fi
  sleep 0.05
done
if kill -0 "$writer_pid" 2>/dev/null; then
  echo "VPN process did not accept the password before the startup deadline." >&2
  exit 1
fi
wait "$writer_pid"
writer_pid=""
sleep 2
if ! systemctl --user is-active --quiet hearth-vpn.service; then
  log_event "vpn.inactive"
  echo "VPN process failed to start; see the private VPN log." >&2
  exit 1
fi
printf '%s\n' hearth-vpn.service > "$state_dir/vpn.pid"
attempt_ready=true
log_event "vpn.active"
