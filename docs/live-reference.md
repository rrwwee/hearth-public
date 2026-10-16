# Live implementation reference

The public snapshot is intended for local demonstration. These notes explain the retained live-capable implementation; configuring or supporting another live installation is not a goal of this snapshot. All examples require operator-supplied configuration. Do not use real credentials when evaluating the demo.

## Configure a real deployment

Real values belong only in ignored local files. Start with the examples:

```sh
mkdir -p "$HOME/Code/dashboard/config"
cp pi/dashboard/config/hearth.env.example "$HOME/Code/dashboard/config/hearth.env"
cp pi/dashboard/config/cluster.example.json "$HOME/Code/dashboard/config/cluster.json"
cp pi/dashboard/config/devices.example.json "$HOME/Code/dashboard/config/devices.json"
cp pi/dashboard/config/notifications.example.json "$HOME/Code/dashboard/config/notifications.json"
cp pi/dashboard/config/ntfy-server.example.yml "$HOME/Code/dashboard/config/ntfy-server.yml"
```

Replace every example hostname, account, route and URL. Then install or invoke only the capabilities required by that deployment:

```sh
# Pi telemetry and web service
pi/dashboard/install-web-service.sh
pi/dashboard/install-user-timer.sh

# Optional cluster path
pi/dashboard/install-cluster-ssh-config.sh
pi/dashboard/install-kerberos-config.sh
pi/dashboard/connect-cluster-control.sh
pi/dashboard/install-cluster-refresh-timer.sh

# Optional split-route VPN and notifications
pi/dashboard/install-vpn-route-hooks.sh
pi/dashboard/connect-vpn-safe.sh
pi/dashboard/install-ntfy-service.sh
```

Dashboard VPN password entry uses one managed connection. Both
`start-vpn-from-stdin.sh` and the compatibility `start-uoe-vpn-from-stdin.sh`
invoke `pi/dashboard/lib/vpn.sh`. Use
`systemctl --user stop hearth-vpn.service` to disconnect. The separate
`connect-vpn-safe.sh` troubleshooting command remains interactive and runs in
the foreground; avoid using it alongside the managed connection.

Each explicit connect request replaces the existing connection. Overlapping
attempts are rejected. The helper verifies the physical gateway route before
stopping either the current `hearth-vpn` or legacy `hearth-uoe-vpn` process.
Passwords travel through a private temporary FIFO. New logs and the process
marker use `HEARTH_STATE_DIR/vpn.log`, `vpn.log.pppd`, and `vpn.pid`; existing
legacy logs are left in place. If the process starts but the cluster probe
fails, the VPN stays running to retry and the dashboard reports unverified
cluster access.

The dashboard allows six seconds for the VPN helper. On timeout it cancels
the helper's process group, including blocked foreground commands, and allows
one second for cleanup before forcing termination. The request remains busy
until those processes close; the systemd-owned VPN is outside that process group.

For an existing deployment, update the shared library and launchers together.
Replace any loose UOE helper with the new compatibility launcher; it resolves
the shared library through `HEARTH_BASE_DIR/current` when no sibling library
exists. Explicitly rerun `install-vpn-route-hooks.sh` from the updated release
to install hooks that recognize both PPP identifiers. Deploying the web release
alone does not replace loose helpers or root-owned PPP hooks. The installed
hooks remain self-contained and do not source the user-owned shared library.

For a non-Pi live web process, copy `.env.example` to `.env`, replace its placeholders, and run:

```sh
npm run start:live
```

Validate live configuration without listening, running adapters, writing state or starting notifications:

```sh
HEARTH_MODE=live npm run validate:live
```

## Notification recovery

Cluster query results are accepted independently. A reachable SSH host does not
prove that `squeue` succeeded: each query must report successful completion, and
the entire primary jobs result must be valid before it can update the jobs
baseline. Failed, incomplete, malformed, or legacy results without explicit
query validity preserve the previous notification baseline. A confirmed empty
result clears it normally. Completed valid results survive failure of a later
query; collection and health diagnostics share a bounded execution budget.

The dashboard marks unavailable jobs and their derived summaries explicitly,
while retaining independently available node allocation and power readings.
Unavailable jobs do not mean zero jobs, and a scheduler query failure does not
request a password. Confirmed remote execution establishes recovered access
even when the scheduler query itself fails. Optional start estimates, display
names, partition metadata, and accounting each report their own availability.
See [the collection decision](adr/0003-independent-cluster-observations.md).

Cluster and network collection have independent failure boundaries within one
serialized monitor. Their observations and pending notifications are saved
before delivery; an accepted send is checkpointed separately. Pending alerts
survive disappearing jobs/devices, hour rollover and process restarts. The send
phase has a 20-second budget and alternates domains so a failing source or alert
does not monopolize the pass. Network collection may still wait for the bounded
cluster command timeout.

The private `notification-state.json` is atomically replaced and synchronized
before sending. Only one web process may own this state file. A missing file
starts a quiet baseline; invalid, unreadable or unsupported state stops the
monitor pass and logs the error without resetting the file. Preserve that file
when investigating recovery failures. A crash after endpoint acceptance but
before acknowledgement can replay the same identity; sequence IDs do not imply
exactly-once delivery. Synchronization reduces power-loss exposure, but storage
hardware and filesystem guarantees still apply.

Retries use the current destination, credentials and dashboard links. Disabling
notifications pauses the monitor and retains pending records. Missing notification
configuration also means disabled. While disabled or invalid, configuration is
checked every 30 seconds; enabling or repairing it resumes monitoring without a
restart. Password reminders
are cancelled after confirmed recovery or a change in required credentials.
Their interval starts at successful delivery. Pending hourly summaries retain
their original UTC interval; only the most recently completed hour is newly
summarized after downtime.

### Notification configuration

Live validation, monitoring, and network dashboard presence use the same
notification configuration contract. Existing files must be JSON objects with
an explicit boolean `enabled`. Enabled notifications require both an explicit
HTTP(S) `endpoint` and a nonblank `topic`; there is no implicit public endpoint.
Endpoint path prefixes are supported, but credentials, queries and fragments
are not. Topics are preserved exactly and cannot be `.` or `..`.

Defaults apply only to omitted fields. Unknown fields, wrong JSON types, zero,
fractions and out-of-range timing/count values are errors, including when
notifications are disabled. Numeric strings are not converted. Optional
`dashboardUrl` and `networkUrl` accept HTTP(S) links, including queries/fragments,
or an empty string. Optional `token` must be a valid authorization-header string;
`cache` must be boolean and defaults to `true`.

| Setting | Default | Allowed integers (inclusive) |
| --- | ---: | --- |
| `pollMs` | 30000 | 1000–2147483647 |
| `deliveryTimeoutMs` | 10000 | 1000–MAX_SAFE |
| `networkPollMs` | 30000 | 1–MAX_SAFE |
| `networkJoinScans` | 2 | 1–MAX_SAFE |
| `networkOnlineGraceMs` | 600000 | 1–MAX_SAFE |
| `networkAwayMs` | 2700000 | 1–MAX_SAFE |
| `networkIdentityWindowMs` | 2700000 | 1–MAX_SAFE |
| `networkUnknownRetentionMs` | 604800000 | 1–MAX_SAFE |
| `bluetoothPollMs` | 300000 | 1–MAX_SAFE |
| `bluetoothScanSeconds` | 8 | 3–20 |
| `reminderMs` | 1800000 | 1–MAX_SAFE |

`MAX_SAFE` is `9007199254740991`. Durations use milliseconds except
`bluetoothScanSeconds`. Require online grace ≤ away interval ≤ unknown-device
retention. The existing 20-second per-pass delivery budget still applies.

Malformed or unreadable configuration fails live validation. During ordinary
operation it pauses background collection and delivery while the dashboard
remains available. Read-only presence projection uses the last valid presence
policy in memory, or defaults before one has loaded. Error changes and recovery
appear in the existing diagnostics log/API without raw settings or credentials.
A pass already collecting may finish and checkpoint observations; each delivery
checks configuration again. Requests already in flight may finish and have their
outcomes checkpointed.

When upgrading, make any formerly implicit endpoint explicit, replace coerced
values with the correct JSON types, and correct invalid inactive fields rather
than relying on fallback or clamping. See the [configuration decision](adr/0005-pause-notifications-on-invalid-configuration.md).

## Deploy to a Pi

The live deployment can fetch an exact commit from the configured repository while
keeping identifying configuration, operational state and private media outside
Git. The first deployment needs a copy of `pi/dashboard/deploy-from-git.sh` at
`$HEARTH_BASE_DIR/deploy-from-git.sh`. Subsequent deployments update that stable
launcher from the validated release.

For the first upgrade from a launcher installed before transactional activation,
use the one-time procedure below. `scripts/deploy-to-pi.sh` invokes the launcher
already installed on the Pi, so using it for this transition would still run the
old activation and rollback logic.

Run the procedure **on the Pi, as the user who owns the service**, from a separate
trusted repository checkout containing the reviewed commit. Set
`HEARTH_UPGRADE_COMMIT` to that full commit ID and `HEARTH_BASE_DIR` to the existing
installation directory, for example `/home/pi/Code/dashboard`. Preserve any
other `HEARTH_*` path overrides and `PORT` used by that installation. Do not use
`sudo`. This procedure performs a deployment; run it only when that deployment
has been authorized.

```sh
# One-time launcher transition
(
  set -eu
  : "${HEARTH_UPGRADE_COMMIT:?Set the full reviewed commit ID}"
  : "${HEARTH_BASE_DIR:?Set the existing installation directory}"
  export HEARTH_BASE_DIR
  test "$(git rev-parse --verify "${HEARTH_UPGRADE_COMMIT}^{commit}")" = "$HEARTH_UPGRADE_COMMIT"
  bootstrap_dir="$(mktemp -d)"
  trap 'rm -rf -- "$bootstrap_dir"' EXIT
  for deploy_file in deploy-from-git.sh deploy_protocol.py; do
    git show "${HEARTH_UPGRADE_COMMIT}:pi/dashboard/$deploy_file" > "$bootstrap_dir/$deploy_file"
  done
  bash -n "$bootstrap_dir/deploy-from-git.sh"
  bash "$bootstrap_dir/deploy-from-git.sh" "$HEARTH_UPGRADE_COMMIT"
)
```

This runs a temporary launcher from the pinned commit without invoking or
overwriting the old launcher first. Successful activation installs the new
stable launcher. Failed activation restores the old installation and leaves its
launcher in place; retry using this same one-time procedure after resolving the
failure. If recovery is incomplete, resolve the retained recovery bundle before
retrying. Do not fall back to the old launcher for a failed first upgrade.
After success, the normal remote deployment command below uses the new launcher.
The isolated transition tests execute the shell block above with temporary
installations and command fixtures.

On the Pi, a deployment:

1. fetches the requested revision into a non-live repository cache;
2. extracts the exact commit into a versioned release directory;
3. runs the test suite and validates the live configuration;
4. captures the previous selection, service configuration, release identity and
   running/autostart state under the deployment lock;
5. atomically moves `current`, updates the deployment-managed service override
   and verifies the effective configuration before restarting; and
6. verifies `/api/health`, restoring the prior installation on activation failure.

Run a later deployment from another machine with:

```sh
HEARTH_DEPLOY_BASE=/home/pi/Code/dashboard \
  scripts/deploy-to-pi.sh pi-dashboard origin/main
```

For a Pi without repository credentials, choose bundle transport explicitly:

```sh
HEARTH_DEPLOY_BASE=/home/pi/Code/dashboard \
  scripts/deploy-to-pi.sh --bundle --source /path/to/trusted/checkout \
  pi-dashboard <reviewed-revision>
```

`--source` defaults to the checkout containing the script. Bundle mode requires
an explicit revision, resolves it once, and reports its full commit ID and the
checkout's dirty status. Local edits and untracked files remain untouched and
are excluded. The complete bundle is verified on the Pi, uses an isolated
repository cache, and never changes the normal origin. Transport never falls
back automatically. The caller must trust and review the chosen committed source;
a checksum proves transfer integrity, not review provenance.

Both the installed launcher and candidate release must support deployment
protocol 1. The stable `deploy_protocol.py` beside the launcher is also managed
by the activation transaction and restored during rollback. Older candidates
are rejected before activation so they cannot remove the unresolved-outcome
guard. An unsupported installation needs an explicit upgrade, including the
[credential-free bootstrap procedure](deployment-bundles.md).

Validation reports three steps: `syntax`, `fixtures`, and `live-configuration`.
Syntax checks and `npm test` receive an environment without inherited `HEARTH_*`,
`PORT`, or Git overrides; fixtures supply their own temporary installation and
repository settings. Ordinary runtime settings such as `PATH` and `HOME` remain.
Live-configuration validation retains the actual target settings and checks the
candidate agent and target configuration/state paths before activation. Do not
manually unset target settings for the deployment command. Validation subprocesses
have no interactive input. Failures retain `phase: "validation"` and the failing
`validationStep` in the private receipt, with named output in `diagnostics.log`.
See [validation environments](deployment-bundles.md#validation-environments).

Private receipts live under `state/deploy-attempts/<attempt-id>/`. Confirmed
success, verified rollback and pre-activation failure remove that attempt's
temporary transfer/cache files while retaining its receipt and bounded
diagnostics. Unknown outcomes and incomplete recovery retain remote artifacts.
Ctrl-C requests cancellation and waits for the existing transaction's recovery;
it does not force-kill recovery. A dropped SSH connection can leave an unknown
outcome and must not trigger an automatic retry. Both transports block unresolved
attempts. Follow the [inspection and reconciliation instructions](deployment-bundles.md)
before retrying; deleting a guard does not establish what happened.

The Pi reports the running commit from `/api/health`. Releases live under
`$HEARTH_BASE_DIR/releases`; configuration and state remain under
`$HEARTH_BASE_DIR/config` and `$HEARTH_BASE_DIR/state`. A private background
video may be stored at `$HEARTH_BASE_DIR/private/public/background.mp4` and is
linked into each release without entering Git.

Deployment preserves the main service unit, custom drop-ins and private
environment files. It owns only `50-hearth-release.conf` in the service's drop-in
directory and `config/hearth-release.env`, which select the release directory,
agent and release identity. Those files are marked as managed; an unmarked file
at either path is a conflict. Private settings continue to apply, while the
managed environment file supplies the selected release's identity and agent.
Conflicting overrides, opaque custom start commands, masked/transitional
services and unknown configuration layouts stop deployment instead of being
silently rewritten. Supported start commands run `node server.js` directly.

An existing installation keeps its autostart policy. A stopped service starts
temporarily for health verification and returns to inactivity on success.
A first installation starts Hearth and enables its user service. Starting at
boot before login also requires user lingering, which deployment does not
change. An existing unit without `current` is treated as a migration.

Activation failures, including reload/restart errors, unexpected health
responses, launcher-update errors and normal cancellation, enter one recovery
attempt. Recovery preserves the exact previous symlink and configuration and
restores the prior running state. It does not infer release identity from a
directory name. Automatic recovery after power loss or an uncatchable process
termination is outside this mechanism.

If recovery cannot finish, deployment returns failure and retains a private
`state/deploy-recovery/` directory. Its `snapshot.json` maps original paths to
backups and records the previous service state and release identity;
`failure.txt`, when present, lists restored steps and remaining failures.
Do not run another deployment until this recovery is resolved. To recover
manually, inspect the snapshot, stop the candidate service, restore the listed
files or symlinks (remove paths recorded as absent), reload the user service
manager, and restore the recorded autostart/running policy. Verify the previous
release through `/api/health` if it was running. Keep the bundle until those
checks pass, then move it outside `state/deploy-recovery/` before retrying.
Backups can contain private configuration; keep them private. Completed
activation or verified rollback removes its recovery material.

The deployment launcher needs Python 3 as well as the existing Git, Node.js and
systemd tools. A target release must include `pi/dashboard/deploy_activation.py`;
older releases without the transaction helper are rejected before activation.
For isolated tests, `HEARTH_SYSTEMD_USER_DIR` overrides the user-unit directory.

`npm test` exercises deployment through temporary installations and command
fixtures. `npm run verify:deploy-systemd` additionally builds a disposable Linux
container and exercises real user-service activation and recovery. The latter
requires Docker; its runtime has no external network, published ports or host
mounts, and starts only fixture services.

The optional household video is intentionally not distributed. This public snapshot uses a plain black background and hides the video, shading, and glow layers.

## Security and privacy model

- Real device aliases, addresses, notification topics, infrastructure hosts and account identifiers are ignored.
- Example networks use documentation-only address ranges and `.invalid` hostnames.
- Operational state, caches, logs, credentials and local media are excluded from Git.
- Demo mode cannot execute live adapters even if live-looking environment variables are supplied.
- Device naming, diagnostics and password actions require an admitted socket peer and an allowed dashboard destination; any supplied Origin must match that destination in live mode. See the access configuration below.
- Before publication, create a clean public history and scan that history independently; sanitising only the latest commit is insufficient.

The examples document structure, not production policy. Review SSH, sudo, VPN, reverse-proxy and ntfy access controls for the environment where Hearth is deployed.

### Dashboard access configuration

The listener defaults to `127.0.0.1` in both live and demo mode. Setting
`HEARTH_BIND` explicitly enables other listening addresses. **Ordinary dashboard
telemetry and health remain readable by anyone who can reach that listener.**
The additional policy below protects diagnostics, manual device-label edits,
and password actions; it is not a login system.

| Setting | Default | Meaning |
| --- | --- | --- |
| `HEARTH_BIND` | `127.0.0.1` | Listener address. Broad binding deliberately exposes ordinary dashboard data. |
| `HEARTH_TRUSTED_CLIENTS` | Empty | Comma-separated exact IPv4/IPv6 addresses admitted for direct protected requests, in addition to loopback. No hostnames or network ranges. |
| `HEARTH_TRUSTED_PROXIES` | Empty | Comma-separated exact IP addresses of private proxies responsible for restricting their callers. Proxy classification takes precedence over direct and loopback admission. |
| `HEARTH_ALLOWED_ORIGINS` | Local origins | Additional comma-separated HTTP(S) origins, including non-default ports. No credentials, paths other than an optional trailing slash, queries, or fragments. |

Local origins are `http://127.0.0.1:PORT`, `http://localhost:PORT`, and
`http://[::1]:PORT`, using the configured port. Explicit origins are added to
these defaults. Scheme, hostname, and effective port must match; a supplied
Origin cannot authorize a different Host. An absent Origin supports command-line
clients but still requires an admitted source and allowed destination. HTTP and
HTTPS default ports are normalized. Address forms are normalized too, including
IPv4-mapped IPv6. Invalid access settings stop startup and fail live-configuration
validation. Restart Hearth after changing them. Demo mode ignores the three
private access-policy settings and continues to prohibit live mutations.

For direct local use, leave these settings unset and open
`http://127.0.0.1:4173`. Loopback admission trusts the programs running on the
Hearth host, including responsibility for any local forwarding services.

For direct access over an **encrypted private overlay**, explicitly admit each
client and each dashboard origin. This illustrative configuration uses
documentation addresses: replace them with the actual overlay client and server
addresses, and a dashboard hostname if used.

```sh
HEARTH_BIND=0.0.0.0
HEARTH_TRUSTED_CLIENTS=192.0.2.20,2001:db8::20
HEARTH_ALLOWED_ORIGINS=http://192.0.2.10:4173,http://[2001:db8::10]:4173,http://hearth.example.invalid:4173
```

Choose an IPv6-capable `HEARTH_BIND` if serving the IPv6 origin; listing an
address or origin does not create another listener.

Source admission is device-level trust: every user or process able to connect
from an admitted device receives the protected privileges. Hearth does not
discover tailnet membership, and the shared `100.64/10` range is not an allowlist.
Operators must ensure overlay encryption; an IP address itself proves neither
transport encryption nor individual identity. Do not send passwords over direct
HTTP on an unencrypted remote network. Use the private HTTPS proxy path for other
remote access.

For a private HTTPS proxy on the same host, one possible arrangement is:

```sh
HEARTH_BIND=127.0.0.1
HEARTH_TRUSTED_PROXIES=127.0.0.2
HEARTH_ALLOWED_ORIGINS=https://hearth.example.invalid
```

Configure that proxy to connect **from** `127.0.0.2` **to** Hearth's
`127.0.0.1:4173` listener. Listing a proxy address does not configure the proxy's
outgoing address. This distinct source lets ordinary local clients continue
using `127.0.0.1`. If the proxy instead shares `127.0.0.1`, list that address and
expect every protected request from it, including command-line requests, to
require the proxy contract.

The proxy must restrict access to the intended private callers, terminate HTTPS,
preserve the external Host (including its non-default port), replace
caller-supplied forwarding metadata, and send exactly one
`X-Forwarded-Proto: https`. Missing, duplicate, comma-separated, or other scheme
values are rejected. Hearth derives the external destination from that Host and
the verified proxy scheme. It does not use `Forwarded`, `X-Forwarded-Host`, or
`X-Forwarded-For` to establish admission or the destination, and does not maintain
a separate forwarded-client allowlist. All callers admitted by this proxy
receive the protected privileges.

An undeclared proxy forwarding through loopback is indistinguishable from
another local program; control local services accordingly. Public,
unauthenticated proxy access is unsupported. Forwarding headers from an
unconfigured peer never grant access or change the effective HTTP scheme.

**Migration:** installations that omitted `HEARTH_BIND` previously listened on
all IPv4 interfaces; set an explicit bind if remote access is intended. Previously
implicit overlay clients now need explicit device addresses and dashboard
origins. Proxies need explicit peers, allowed HTTPS origins, and the forwarding
contract above. Keep source admission, browser-origin checks, and authentication
distinct when configuring external controls; do not rely on an unspecified
firewall or on HTTPS alone.

