# VPN lifecycle fixtures

Run `node --test test/vpn-lifecycle.test.js test/vpn-fixture.test.js` for the real
shell scenarios and fixture failure regressions. These tests use synthetic
configuration and private temporary directories. They do not connect to a VPN.

`vpn-fixture.js` owns each launcher's process group, including inherited worker
children. `vpnTest` reports scenario failures together with captured output,
command history, worker output, and cleanup errors. It stops owned groups before
removing their private files. A group that cannot be confirmed stopped causes
teardown to fail instead of silently deleting resources still in use.

Failure output is bounded: the most recent eight launches retain status fields
and bounded stdout/stderr, along with bounded command and worker log tails.
Passwords are redacted before truncation. The original scenario error and
cleanup errors receive separate output budgets so one cannot consume the entire
report. Normal successful runs do not print diagnostic reports.

To retain sanitized failure reports, opt in explicitly:

```sh
VPN_TEST_DIAGNOSTICS_DIR=/tmp/hearth-vpn-reports node --test test/vpn-lifecycle.test.js
```

Only private, mode-0600 `.log` files are retained there. The fixture directory,
password input, and temporary FIFOs are never copied. A diagnostics-write failure
still permits private fixture cleanup and fails the test. The environment option
does not become a setting for the production launcher.

The fixture sleep adapter preserves the previous 20 ms cap for the launcher's
`0.05` polling argument, using system sleep without a Python startup. Readiness
sleeps (`2`) and other arguments use the original Python adapter. Production sleep intervals, polling
counts, and deadlines are unchanged. Keep the 30-second non-collection fixture
watchdog separate from the production VPN deadline tests and real-systemd checks.

# Deployment validation candidate

`test/deployment_candidate.py` assembles the candidate used by the real-validation
test in `test/test_deploy_bundle.py`. It reads the current working tree, including
uncommitted edits and new non-ignored files, then commits a separate temporary
repository for both bundle and direct-fetch deployment commands.

The source policy selects `server.js` and the `lib`, `demo`, `public`, and
`pi/dashboard` trees. Supported source extensions are `.js`, `.mjs`, `.cjs`, `.py`,
`.sh`, `.html`, and `.css`; the dashboard configuration directory permits only
example files. Git ignore rules also apply to tracked files. Hidden paths,
generated/state directories, other file types, and symlinks are excluded.
New modules in these source trees need no fixture filename entries.

The builder generates its own package scripts and JavaScript validation test and
copies only the collector's Python test and its environment helper. The outer
deployment suite and root package scripts never enter the candidate. Candidate
tests run without inherited installation settings; live validation retains the
synthetic target configuration, as required by ADR-0004.

# Deployment protocol compatibility

`deployment_v1.py` freezes the read-only activation helpers and reconciliation
method from the earlier protocol version, before installation evidence had a shared owner.
Unused imports and the activation transaction are omitted. The deployment CLI
tests use it as a helper-only old release and as an old coordinator's
reconciliation method, so compatibility checks do not silently track changes to
the new evidence implementation or require Git history in deployment exports.
