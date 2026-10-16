# Optional fixture measurements

These tools measure synthetic lifecycle fixtures. Historical machine measurements and private comparison records are not distributed. This directory remains part of source discovery and the syntax-test export fixture.

Run from the repository root with the verification prerequisites installed:

```sh
python3 docs/benchmarks/issue-21/adapter_costs.py
PYTHONDONTWRITEBYTECODE=1 python3 docs/benchmarks/issue-21/python_timings.py
ISSUE21_PROFILE_OUTPUT=/tmp/hearth-vpn-profile.jsonl node --import ./docs/benchmarks/issue-21/instrument.mjs --test --test-name-pattern 'reconnect refuses a replacement' test/vpn-lifecycle.test.js
```

The Node preload records filesystem timings, command counts, and child durations. Its output path must be explicitly supplied. The Python tools measure fixture adapter costs and bundle-test timings. These instrumented runs do not replace ordinary release checks or establish live-installation performance. Use synthetic fixtures only, keep diagnostic output private, and compare runs under consistent load and runtime conditions.
