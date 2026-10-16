#!/usr/bin/env bash
# Keep missing Python diagnosable without npm or any installed lint packages.
set -eu
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  json=false
  for arg in "$@"; do
    if [ "$arg" = --json ]; then json=true; fi
  done
  if "$json"; then
    printf '%s' '{"mode":"unavailable","exit_code":1,"elapsed_seconds":0,"results":['
    printf '%s' '{"check":"python","status":"fail","category":"prerequisite","detail":"Missing python3; see README.md#verification."}'
    for check in node npm-tools python-tools loopback checkout freshness docker; do
      printf ',{"check":"%s","status":"unknown","category":"prerequisite","detail":"Python is required to perform this check."}' "$check"
    done
    printf ']}'
    printf '\n'
  else
    printf '%s\n' 'FAIL           python: Missing python3; see README.md#verification.'
    for check in node npm-tools python-tools loopback checkout freshness docker; do
      printf 'UNKNOWN        %s: Python is required to perform this check.\n' "$check"
    done
  fi
  exit 1
fi
exec python3 -I -B "$script_dir/preflight.py" "$@"
