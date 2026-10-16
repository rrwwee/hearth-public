import test from "node:test";
import assert from "node:assert/strict";
import { observedCredentialNeed } from "../public/cluster-credential-policy.js";

test("observed credential need identifies an explicit VPN password failure", () => {
  assert.equal(observedCredentialNeed({
    reachable: false,
    health: { checks: [{ key: "vpn", ok: false, state: "needs password" }] },
  }), "vpn");
});

const vpn = { key: "vpn", ok: false, state: "needs password" };
const ticket = { key: "ticket", ok: false, state: "needs password" };
const withChecks = (...checks) => ({ reachable: false, health: { checks } });

const cases = [
  ["absent cluster", undefined, null],
  ["null cluster", null, null],
  ["unconfigured cluster overrides failed checks", { ...withChecks(vpn), configured: false }, null],
  ["reachable cluster overrides failed checks and notes", {
    ...withChecks(vpn, ticket), reachable: true, note: "permission denied",
  }, null],
  ["reachable scheduler failure is not a credential need", {
    reachable: true, queries: { jobs: { status: "failed" } }, note: "connection timed out",
  }, null],
  ["explicit ticket failure", withChecks(ticket), "cluster"],
  ["VPN takes precedence even when ticket appears first", withChecks(ticket, vpn), "vpn"],
  ["healthy VPN allows ticket need", withChecks({ ...vpn, ok: true }, ticket), "cluster"],
  ["healthy checks suppress conflicting note", {
    ...withChecks({ ...vpn, ok: true }), note: "connection timed out",
  }, null],
  ["unrelated checks suppress note fallback", {
    ...withChecks({ key: "slurm", ok: false, state: "blocked" }), note: "permission denied",
  }, null],
  ["unknown health supplies no credential need", withChecks({ ...vpn, state: "unknown" }), null],
  ["credential state matching is exact", withChecks({ ...vpn, state: "Needs password" }), null],
  ["missing ok retains falsy interpretation", withChecks({ key: "ticket", state: "needs password" }), "cluster"],
  ["first healthy VPN duplicate wins", withChecks({ ...vpn, ok: true }, vpn), null],
  ["first failed VPN duplicate wins", withChecks(vpn, { ...vpn, ok: true }), "vpn"],
  ["first healthy ticket duplicate wins", withChecks({ ...ticket, ok: true }, ticket), null],
  ["first failed ticket duplicate wins", withChecks(ticket, { ...ticket, ok: true }), "cluster"],
  ["explicit ticket need overrides VPN note", { ...withChecks(ticket), note: "no route to host" }, "cluster"],
  ["empty checks allow note fallback", { ...withChecks(), note: "Kerberos failed" }, "cluster"],
  ["non-array checks allow note fallback", { health: { checks: {} }, note: "no route to host" }, "vpn"],
  ["missing checks allow note fallback", { health: {}, note: "permission denied" }, "cluster"],
  ["VPN note wins when both types are mentioned", { note: "Kerberos failed: connection timed out" }, "vpn"],
  ["unconfigured cluster suppresses note fallback", { configured: false, note: "no route to host" }, null],
  ["missing note", {}, null],
  ["unrelated note", { note: "temporary DNS failure" }, null],
];

for (const [name, cluster, expected] of cases) {
  test(`observed credential need: ${name}`, () => {
    assert.equal(observedCredentialNeed(cluster), expected);
  });
}

for (const [need, phrases] of [
  ["vpn", ["network is unreachable", "no route to host", "connection timed out", "vpn tunnel started"]],
  ["cluster", ["permission denied", "kerberos", "ticket", "refresh the configured jump connection"]],
]) {
  for (const phrase of phrases) {
    test(`legacy diagnostic identifies ${need} need: ${phrase}`, () => {
      assert.equal(observedCredentialNeed({ note: `Diagnostic: ${phrase.toUpperCase()}.` }), need);
    });
  }
}
