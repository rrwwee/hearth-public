import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardAccessPolicy } from "../lib/dashboard-access.js";

function request(remoteAddress, headers = {}, rawHeaders) {
  const values = { host: "127.0.0.1:4173", ...headers };
  return { socket: { remoteAddress }, headers: values,
    rawHeaders: rawHeaders ?? Object.entries(values).flat() };
}

test("a forged HTTPS assertion cannot admit an untrusted dashboard source", () => {
  const policy = createDashboardAccessPolicy();
  for (const origin of [undefined, "https://example.invalid"]) {
    const headers = { host: "example.invalid", "x-forwarded-proto": "https" };
    if (origin) headers.origin = origin;
    const result = policy.check(request("203.0.113.123", headers));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "source");
  }
});

test("direct admission uses exact normalized device addresses and loopback", () => {
  const overlay = [100, 70, 0, 10].join(".");
  const policy = createDashboardAccessPolicy({ trustedClients: `192.0.2.10,2001:db8::10,${overlay}` });
  for (const address of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:7f00:1", "192.0.2.10", "::ffff:c000:20a",
    "2001:0db8:0:0:0:0:0:10", overlay]) {
    assert.equal(policy.check(request(address)).ok, true, address);
  }
  for (const address of [undefined, "", "not-an-address", "192.0.2.11", "2001:db8::11", [100, 70, 0, 11].join(".")]) {
    assert.equal(policy.check(request(address)).reason, "source", String(address));
  }
});

test("invalid device and proxy configuration fails without exposing supplied values", () => {
  for (const key of ["trustedClients", "trustedProxies"]) {
    for (const value of ["secret.invalid", "192.0.2.0/24", "999.0.0.1", "192.0.2.1,", "fe80::1%en0"]) {
      assert.throws(() => createDashboardAccessPolicy({ [key]: value }), (error) => {
        assert.match(error.message, /configuration/);
        assert.ok(!error.message.includes(value));
        return true;
      });
    }
  }
});

test("non-mapped IPv6 prefixes cannot impersonate loopback or admitted IPv4 devices and proxies", () => {
  const policy = createDashboardAccessPolicy({ trustedClients: "192.0.2.10", trustedProxies: "192.0.2.20" });
  for (const address of ["::ffff:7f00:1:2", "::ffff:c000:20a:3", "::ffff:c000:214:3"]) {
    assert.equal(policy.check(request(address)).reason, "source", address);
  }
  const explicit = createDashboardAccessPolicy({ trustedClients: "::ffff:7f00:1:2" });
  assert.equal(explicit.check(request("::ffff:7f00:1:2")).ok, true);
  assert.equal(explicit.check(request("::ffff:7f00:1:3")).reason, "source");
});

test("a configured proxy requires a single HTTPS assertion, even when also admitted directly", () => {
  const policy = createDashboardAccessPolicy({ trustedProxies: "127.0.0.1,192.0.2.20",
    trustedClients: "192.0.2.20", allowedOrigins: "https://hearth.example.invalid" });
  for (const address of ["127.0.0.1", "::ffff:192.0.2.20"]) {
    const headers = { host: "hearth.example.invalid", origin: "https://hearth.example.invalid", "x-forwarded-proto": "https" };
    assert.equal(policy.check(request(address, headers)).ok, true);
    for (const scheme of [undefined, "", "http", "HTTPS", "https,http", ["https", "https"]]) {
      const badHeaders = { ...headers, "x-forwarded-proto": scheme };
      assert.equal(policy.check(request(address, badHeaders)).reason, "proxy", String(scheme));
    }
    const duplicate = ["Host", "hearth.example.invalid", "X-Forwarded-Proto", "https", "x-forwarded-proto", "https"];
    assert.equal(policy.check(request(address, headers, duplicate)).reason, "proxy");
  }
});

test("allowed destinations and complete origins are required independently of source admission", () => {
  const policy = createDashboardAccessPolicy({ trustedClients: "192.0.2.10",
    allowedOrigins: "http://device.example.invalid:4173,http://[2001:db8::10]:4173" });
  for (const host of ["127.0.0.1:4173", "localhost:4173", "[::1]:4173"]) {
    assert.equal(policy.check(request("::1", { host, origin: `http://${host}` })).ok, true);
  }
  for (const host of ["device.example.invalid:4173", "[2001:db8::10]:4173"]) {
    assert.equal(policy.check(request("192.0.2.10", { host })).ok, true, "Origin may be absent");
    assert.equal(policy.check(request("192.0.2.10", { host, origin: `http://${host}` })).ok, true);
  }
  for (const origin of ["https://127.0.0.1:4173", "http://127.0.0.1:4174", "http://elsewhere.invalid:4173", "null", "", "http://[", ["http://127.0.0.1:4173"]]) {
    assert.equal(policy.check(request("::1", { origin })).reason, "origin", String(origin));
  }
  for (const host of ["evil.invalid", "127.0.0.1:4174", "user@127.0.0.1:4173", "127.0.0.1:4173/path", "127.0.0.1:4173,evil.invalid", undefined]) {
    assert.equal(policy.check(request("::1", { host })).reason, "destination", String(host));
  }
  assert.equal(policy.check(request("::1", {}, ["Host", "127.0.0.1:4173", "host", "evil.invalid"])).reason, "destination");
  assert.equal(policy.check(request("::1", { origin: "http://127.0.0.1:4173" }, ["Host", "127.0.0.1:4173", "Origin", "http://127.0.0.1:4173", "origin", "http://evil.invalid"])).reason, "origin");
});

test("default ports normalize, proxy host claims cannot override Host, and direct forwarding is ignored", () => {
  const policy = createDashboardAccessPolicy({ trustedProxies: "192.0.2.20", port: 80,
    allowedOrigins: "https://hearth.example.invalid:443" });
  assert.equal(policy.check(request("::1", { host: "localhost:80", origin: "http://localhost", "x-forwarded-proto": "https" })).ok, true);
  const headers = { host: "hearth.example.invalid:443", origin: "https://hearth.example.invalid", "x-forwarded-proto": "https",
    "x-forwarded-for": "203.0.113.123", "x-forwarded-host": "elsewhere.invalid", forwarded: "for=203.0.113.123;proto=http" };
  assert.equal(policy.check(request("192.0.2.20", headers)).ok, true);
  assert.equal(policy.check(request("192.0.2.20", { ...headers, host: "evil.invalid", "x-forwarded-host": "hearth.example.invalid" })).reason, "destination");
  assert.equal(policy.check(request("::1", headers)).reason, "destination", "unconfigured peer cannot claim an HTTPS destination");
});

test("invalid allowed origins fail startup without echoing their values", () => {
  for (const allowedOrigins of ["https://secret.invalid/path", "https://user:password@secret.invalid", "https://secret.invalid?token=secret",
    "https://secret.invalid#fragment", "ftp://secret.invalid", "null", "https://secret.invalid,", "https://secret.invalid\\path"]) {
    assert.throws(() => createDashboardAccessPolicy({ allowedOrigins }), (error) => {
      assert.match(error.message, /HEARTH_ALLOWED_ORIGINS/);
      assert.ok(!error.message.includes(allowedOrigins));
      return true;
    });
  }
});
