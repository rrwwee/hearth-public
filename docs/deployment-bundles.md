# Bundle deployment and reconciliation

Bundle transport needs Git and Python 3 on the source host, noninteractive SSH
access to the service owner's account, and the existing deployment prerequisites
on the Pi. Use a full, non-shallow, non-partial trusted source checkout. No GitHub
credentials are needed on the Pi. The service account must be able to write its
installation and its user-service configuration.

The normal command is:

```sh
HEARTH_DEPLOY_BASE=/home/pi/Code/dashboard \
  scripts/deploy-to-pi.sh --bundle --source /path/to/trusted/checkout \
  pi-dashboard <reviewed-revision>
```

The source argument is optional; the revision is required. The command prints
the immutable commit and whether local changes exist. It creates a temporary
ref, a complete bundle, and a SHA-256 digest, and removes its local temporary
artifacts on normal exit or catchable cancellation. The Pi checks the digest,
bundle prerequisites, advertised commit and imported object integrity before
staging and running the release's checks. Git replacement objects are disabled.
Uncatchable termination can leave local temporary files or refs; inspect their
attempt ID before removing them. Remote evidence is independent of local cleanup.

The launcher and its adjacent `deploy_protocol.py` form deployment protocol 1.
Both are installed/restored by the existing activation transaction. Every
candidate must contain compatible launcher, protocol and activation components.
An older candidate is refused rather than removing the guard for later runs.
Automatic rollback still restores the exact previous installation. Deliberate
migration to an incompatible older release is outside this command.

## Validation environments

Both direct-fetch and bundle deployments run the same validation steps before
selecting a release or restarting the service:

| Step | Command | Environment |
| --- | --- | --- |
| `syntax` | `npm run check:syntax` | Inherited `HEARTH_*`, `PORT`, and `GIT_*` removed |
| `fixtures` | `npm test` | The same cleaned environment; fixtures add their own temporary settings |
| `live-configuration` | `node server.js` | Actual target installation settings, with live validation enabled and the candidate's local agent |

The cleaned environment retains ordinary runtime settings such as `PATH` and
`HOME`. It explicitly disables Git replacement objects and credential prompts,
and Python bytecode writes. This is an installation-setting boundary, not an OS
sandbox or a guarantee that arbitrary candidate code cannot access other files.
Review the committed source before deployment.

No custom PATH wrapper or manual environment cleanup is needed. Keep target path
overrides and `PORT` on the normal deployment command: live validation must check
that installation. Each validation subprocess receives closed standard input,
so validation cannot depend on interactive answers. Direct `npm test` invocation
is also safe from inherited installation settings because fixture setup replaces
them before importing agents or starting child commands.

Receipts retain `phase: "validation"`, adding `validationStep` with one of the
three names above. The step is saved before its command starts and is also named
in `diagnostics.log` and command output. A validation failure records
`failed-before-activation`; it is not an activation or rollback failure. A lost
SSH response still requires receipt inspection before retrying.

## Explicit first upgrade without GitHub credentials

A normal command refuses an unsupported installed launcher. Do not overwrite
that launcher to make the check pass. Instead, use a reviewed protocol-1 commit
and the existing temporary-launcher principle: run the reviewed deployment code
from verified temporary source, allowing the activation transaction to install
the stable files only after success.

Prepare the bundle on the trusted source host. Replace the revision below with
the reviewed revision. This subshell prints the three values needed on the Pi
and retains the bundle directory for transfer; it removes only its temporary
ref. The bundle contains committed history, not local edits.

```sh
(
  set -euo pipefail
  commit=$(git --no-replace-objects rev-parse --verify '<reviewed-revision>^{commit}')
  transfer_dir=$(mktemp -d)
  attempt=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
  ref="refs/hearth/deploy/$attempt"
  trap 'git update-ref -d "$ref" "$commit"' EXIT
  git update-ref "$ref" "$commit" "$(printf '%*s' "${#commit}" '' | tr ' ' 0)"
  git --no-replace-objects bundle create "$transfer_dir/release.bundle" "$ref"
  checksum=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$transfer_dir/release.bundle")
  printf 'Bundle: %s\nCommit: %s\nSHA-256: %s\nAttempt: %s\n' "$transfer_dir/release.bundle" "$commit" "$checksum" "$attempt"
)
```

Create a private temporary directory on the Pi as the service owner and copy the
bundle there using SSH/SCP. Record its absolute path. Keep the expected commit,
checksum and attempt ID from the trusted host; do not infer them from an
unverified file on the Pi. Transfer integrity does not authenticate arbitrary
source code.

Run the following **on the Pi**, filling the four values from those steps and
the installation path. Preserve any existing `HEARTH_*` path overrides and
`PORT`. This explicitly performs a deployment. Do not use `sudo`.

```sh
(
  set -euo pipefail
  export HEARTH_BASE_DIR=/home/pi/Code/dashboard
  transfer_dir='<private-temporary-directory>'
  commit='<expected-full-commit>'
  checksum='<expected-sha256>'
  attempt='<attempt-id>'
  bundle="$transfer_dir/release.bundle"
  actual=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$bundle")
  test "$actual" = "$checksum"
  git init -q "$transfer_dir/verify"
  git -C "$transfer_dir/verify" bundle verify "$bundle"
  git bundle list-heads "$bundle" > "$transfer_dir/heads"
  test "$(wc -l < "$transfer_dir/heads")" -eq 1
  read -r advertised ref < "$transfer_dir/heads"
  test "$advertised" = "$commit"
  git -C "$transfer_dir/verify" fetch "$bundle" "$ref"
  test "$(git -C "$transfer_dir/verify" rev-parse 'FETCH_HEAD^{commit}')" = "$commit"
  git -C "$transfer_dir/verify" fsck --full --no-reflogs "$commit"
  mkdir "$transfer_dir/trusted"
  git -C "$transfer_dir/verify" archive "$commit" | tar -x -C "$transfer_dir/trusted"
  launcher="$transfer_dir/trusted/pi/dashboard/deploy-from-git.sh"
  bash "$launcher" --receive "$attempt" "$commit" "$checksum" "$(wc -c < "$bundle")" < "$bundle"
  bash "$launcher" --deploy-bundle "$attempt"
)
```

The source is verified before executing its launcher. That launcher checks the
shared deployment lock and recovery/attempt evidence even during this explicit
upgrade. Failure before successful activation leaves the old stable launcher
and support file intact. If activation rolls back, retry the explicit upgrade
after verifying the receipt. If recovery is incomplete or the outcome is
unknown, retain the temporary source and bundles and reconcile first. Remove
the explicitly recorded local and Pi transfer directories only after a confirmed
terminal outcome; do not sweep unrelated temporary files.

## Inspecting an interrupted deployment

The installation keeps private evidence in
`$HEARTH_STATE_DIR/deploy-attempts/<attempt-id>/` (by default under the installation's
`state` directory). `receipt.json` identifies the commit, transport, progress and
outcome. `diagnostics.log` captures deployment command output, truncated to its
last 64 KiB after terminal cleanup. `activation-before.json` retains the prior
service policy, identity and configuration fingerprints without storing service
environment secrets. `activation-result.json`, when present, is evidence from
the activation transaction. `unresolved.json` blocks retries until completion
is durably recorded or explicitly reconciled.

Use the service owner's shell and the same installation/path overrides:

```sh
export HEARTH_BASE_DIR=/home/pi/Code/dashboard
bash "$HEARTH_BASE_DIR/deploy-from-git.sh" --status <attempt-id>
```

If an explicit upgrade failed and the stable launcher is still old, use the
verified temporary launcher retained from the upgrade for these commands.

An SSH error alone says nothing conclusive about activation. Check the receipt
and diagnostics, the selected `current` link, the service's running/autostart
policy, and `/api/health` if running. An originally stopped service is expected
to return to inactivity after successful temporary health verification. Health
identifies the dashboard release; it does not assert VPN or ntfy health.

If `state/deploy-recovery/` remains unresolved, follow the live-reference.md recovery
procedure first. Preserve its backups until restoration is verified. Receipt
files with invalid or unreadable contents are not reset automatically; repair
them from trusted retained evidence before continuing.

Once the expected outcome is established, explicitly reconcile it:

```sh
bash "$HEARTH_BASE_DIR/deploy-from-git.sh" --reconcile <attempt-id> activated
# Or, after verified restoration:
bash "$HEARTH_BASE_DIR/deploy-from-git.sh" --reconcile <attempt-id> rolled-back
# Or abandon a transfer/staging attempt which never reached activation:
bash "$HEARTH_BASE_DIR/deploy-from-git.sh" --reconcile <attempt-id> failed-before-activation
```

Reconciliation takes the deployment lock, refuses unresolved recovery or other
attempts, and checks configuration fingerprints, release identity and service
policy (including health when running) against the saved evidence. It never
starts, stops or repairs a service. On success it records the explicit outcome,
clears that attempt's guard and removes only its temporary artifacts. A lock
being free is necessary, but is not sufficient evidence of a completed deployment.

Ctrl-C requests cancellation of the identified attempt. During activation it
waits for the existing transaction's recovery; it never force-kills recovery.
The activation process and its command children retain the deployment lock if
the coordinator disappears. No background execution guarantee or automatic
retry is provided. Receipts and recovered installation state remain the basis
for deciding what to do next.
