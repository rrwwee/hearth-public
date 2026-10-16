#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point, including loose copies outside the release tree.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -f "$script_dir/lib/vpn.sh" ]; then
  lifecycle="$script_dir/lib/vpn.sh"
else
  lifecycle="${HEARTH_BASE_DIR:-$HOME/Code/dashboard}/current/pi/dashboard/lib/vpn.sh"
fi
exec /bin/bash "$lifecycle"
