# Real systemd VPN lifecycle verification

Run from a machine with Docker:

```sh
./scripts/verify-vpn-systemd.sh
```

The script builds a disposable native Debian Bookworm image, boots systemd as
PID 1, starts an unprivileged user's systemd manager, and runs copies of the
Hearth launchers. It removes its container, image tag, and temporary files on
exit. Initial image/package downloads need network access; the test container
has no network access. The source tree is not mounted into the container.

The container uses private PID, network, and cgroup namespaces, a read-only
mount containing selected source copies and fixtures, and no host devices or
Docker socket. `SYS_ADMIN` and relaxed seccomp/AppArmor profiles let systemd manage
its private cgroup hierarchy; `boot.sh` refuses a non-private cgroup root.

Real components: systemd, systemctl, systemd-run, Bash, sudo, flock, FIFOs, and
process termination. Only DNS lookup, route operations, and openfortivpn are
inert fixtures. Test-only sudoers rules allow the two root-owned fixture
executables; they do not install or modify host authorization.

Checks include:

- Detached worker startup, real noninteractive sudo, and a private stdin password.
- Canonical identity, reconnect after transient-unit collection, and legacy migration.
- Keeping the old process running when gateway-route verification fails.
- Keeping the new process running after the launcher returns.
- Exact arguments containing spaces, dollar signs, and percent signs; optional certificates.
- Overlap rejection across both launcher paths using real flock.
- Failed worker startup, a FIFO without a reader, and cancellation during startup.
- Cancellation of a blocked lookup without stopping the existing VPN, followed by retry.
- Forced cancellation during slow systemd shutdown, without leaving private startup files.
- Private FIFO permissions, secret absence from process arguments/environment and logs,
  temporary-file cleanup, process cleanup, and retry after cancellation.
- Resolution of the shared library by a loose legacy launcher.

Validated with native ARM64 Linux and systemd 252.39. This verifies the lifecycle
and process-management behavior. It does not contact a VPN gateway, verify a
real PPP tunnel or routing policy, or establish that a deployment's sudoers
configuration is correct. The existing HTTP integration test covers the
server's unreachable-cluster response, overlap during its readiness probe, and
deadline escalation for a helper child that ignores SIGTERM.
