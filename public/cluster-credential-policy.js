// Interpret one observation; a null result does not establish credential recovery.
export function observedCredentialNeed(cluster) {
  if (!cluster || cluster.reachable || cluster.configured === false) return null;

  const checks = Array.isArray(cluster.health?.checks) ? cluster.health.checks : [];
  if (checks.length) {
    const vpn = checks.find((check) => check.key === "vpn");
    if (vpn && !vpn.ok && vpn.state === "needs password") return "vpn";
    const ticket = checks.find((check) => check.key === "ticket");
    if (ticket && !ticket.ok && ticket.state === "needs password") return "cluster";
    return null;
  }

  const note = `${cluster.note || ""}`.toLowerCase();
  if (
    note.includes("network is unreachable")
    || note.includes("no route to host")
    || note.includes("connection timed out")
    || note.includes("vpn tunnel started")
  ) {
    return "vpn";
  }
  if (
    note.includes("permission denied")
    || note.includes("kerberos")
    || note.includes("ticket")
    || note.includes("refresh the configured jump connection")
  ) {
    return "cluster";
  }
  return null;
}
