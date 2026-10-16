#!/usr/bin/env bash
# Hearth deployment protocol: 1
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -B "$script_dir/deploy_protocol.py" "$@"
