# Add explicit bundle transport to the existing deployment transaction

Add an explicit `--bundle` mode to `scripts/deploy-to-pi.sh` and reuse the existing staging, validation, activation and recovery implementation. Keep direct-fetch deployment supported. Do not automatically switch transport after a fetch failure: the operator chooses the source, and fallback must not silently select another commit.

Bundle mode requires an explicit revision, resolved once to a full commit ID before creating deployment artifacts. The default source checkout is the repository containing the script; allow an explicit source-directory override. Report the resolved commit and dirty/untracked status, allowing local edits while excluding and preserving them.

Check installed-launcher compatibility before activation. Unsupported launchers stop with precise upgrade instructions; do not bootstrap a replacement automatically. Preserve the documented explicit first-upgrade procedure and its transaction guarantees.

Require both the installed launcher and the candidate release to support the deployment protocol, including the unresolved-outcome guard. Successful activation replaces the launcher from the candidate release, so allowing incompatible candidates would remove safeguards for future deployments. Reject them before activation. Automatic rollback still restores the previous installation; deliberately deploying an older incompatible release requires a separate migration procedure.

An SSH failure after activation begins leaves an unknown deployment outcome. Retain diagnostic evidence and require inspection before retrying; do not infer failure or automatically retry activation. Guaranteed execution after disconnect would require remote supervision and is outside this decision.

## Attempt ownership and retention

Each attempt owns its temporary ref, local artifacts, remote transfer directory and remote repository cache. Cleanup only removes that attempt's artifacts. After confirmed success, verified rollback or confirmed failure before activation, remove temporary refs, bundles, caches and partial transfers. Keep a small private deployment receipt containing the commit, checksum, stage reached, outcome and diagnostics.

For an unknown outcome or incomplete recovery, retain remote artifacts until explicit reconciliation. Preserve the existing transaction's recovery material independently of transport cleanup. Do not automatically prune unresolved evidence. Temporary local refs and artifacts can be removed once the caller no longer needs them; they do not establish the remote outcome.

## Cancellation and reconciliation

Ctrl-C requests cancellation of the specific remote attempt. Before activation, stop safely; during activation, let the existing transaction attempt rollback and wait for its result. Do not force-kill recovery. If cancellation or recovery cannot be confirmed, report an unknown outcome and retain evidence.

Record a private per-attempt outcome on the Pi. Both transports must refuse a subsequent deployment while an earlier outcome is unresolved, even if the process has exited and its lock is free. Manual reconciliation establishes that deployment has stopped, inspects recovery evidence, and verifies the selected release and service policy, plus health when the service is running. Document that process; automatic repair and a resumable deployment service are outside this issue.

## Receipt persistence failures

Save the unresolved-attempt record durably before activation. If that write fails, stop before activation. If the final outcome cannot be saved after activation or rollback has completed, report that completion could not be recorded, retain the unresolved guard and available evidence, and require manual reconciliation. Do not initiate another rollback solely because recording the completed outcome failed.

