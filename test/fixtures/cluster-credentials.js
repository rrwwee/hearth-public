// Shared observations exercise the dashboard and notification boundaries.
export const credentialObservations = [
  { name: "explicit VPN failure", need: "vpn", cluster: {
    reachable: false, health: { checks: [{ key: "vpn", ok: false, state: "needs password" }] },
  } },
  { name: "explicit ticket failure", need: "cluster", cluster: {
    reachable: false, health: { checks: [{ key: "ticket", ok: false, state: "needs password" }] },
  } },
  { name: "legacy VPN diagnostic", need: "vpn", cluster: {
    reachable: false, note: "connection timed out",
  } },
  { name: "legacy ticket diagnostic", need: "cluster", cluster: {
    reachable: false, note: "Kerberos ticket expired",
  } },
  { name: "unknown health", need: null, cluster: {
    reachable: false, health: { checks: [{ key: "ticket", ok: false, state: "unknown" }] },
  } },
  { name: "unconfigured cluster", need: null, cluster: { reachable: false, configured: false } },
  { name: "reachable cluster with failed scheduler query", need: null, cluster: {
    reachable: true, user: "researcher", jobs: null, queries: { jobs: { status: "failed" } },
    health: { checks: [{ key: "ticket", ok: false, state: "needs password" }] },
    note: "permission denied by scheduler",
  } },
];
