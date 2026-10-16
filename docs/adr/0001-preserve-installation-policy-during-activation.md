# Preserve installation policy during activation

Deployment must preserve the installation's custom service configuration and private settings. Release-specific settings belong in a narrowly scoped deployment-managed override rather than a replacement of the existing main unit or custom drop-ins. This adds configuration-conflict handling but avoids discarding operator settings on successful deployment.

An existing installation retains its autostart policy. If its service is inactive, successful activation starts it temporarily for health verification and then restores inactivity. A genuine first installation starts Hearth and enables autostart; failure restores the prior absence of the introduced service configuration and release selection. An existing service without a selected release is a migration, not a first installation.

Activation recovery covers ordinary command failures and catchable cancellation. Automatic recovery after power loss or an uncatchable termination is outside this change; retain recovery material for interrupted activation. This keeps the change bounded without promising recovery that a terminated process cannot perform.

Deployment stops on conflicting operator settings or an installation state that cannot be reliably captured. Detect known conflicts before mutation; if candidate configuration verification exposes a conflict during activation, roll back rather than override the operator's settings.

Attempt recovery once, making each applicable restoration step without hiding individual failures. Incomplete or interrupted recovery retains a private backup and diagnostic bundle and blocks further deployment until resolved. Report what was restored, what failed, and the bundle location. Remove recovery material after successful activation or verified rollback; do not repeatedly restart an uncertain installation.
