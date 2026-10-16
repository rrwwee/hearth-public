import test from "node:test";
import assert from "node:assert/strict";
import { createCredentialOutput, redactCredentialText } from "../lib/credential-output.js";

function capture(password, chunks) {
  const output = createCredentialOutput(password);
  for (const chunk of chunks) output.write(Buffer.from(chunk));
  return output.finish();
}

test("credential output handles every byte split, repeated echoes, and Unicode", () => {
  const password = "fixture-🔑-é";
  const bytes = Buffer.from(`before ${password} then ${password} after`);
  for (let split = 0; split <= bytes.length; split++) {
    const value = capture(password, [bytes.subarray(0, split), bytes.subarray(split)]);
    assert.equal(value.includes(password), false, `credential exposed at byte split ${split}`);
    assert.equal(value, "before [redacted] then [redacted] after");
  }
});

test("credential output masks an unfinished echo at EOF and flushes the UTF-8 decoder", () => {
  assert.equal(capture("fixture-password", ["failure: fixture-pass"]), "failure: [redacted]");
  assert.equal(capture("unrelated", [Buffer.from([0xe2, 0x82])]), "�");
});

test("credential output retains a bounded UTF-8 tail including an omission notice", () => {
  const password = "fixture-secret-value";
  for (const length of [65535, 65536, 65537, 200000]) {
    const value = capture(password, ["x".repeat(length)]);
    assert.ok(Buffer.byteLength(value) <= 65536);
    assert.equal(value.includes("earlier output omitted"), length > 65536);
  }
  const value = capture(password, ["古".repeat(100000), password.slice(0, 7), password.slice(7), "\nfinal reason"]);
  assert.ok(Buffer.byteLength(value) <= 65536);
  assert.equal(value.includes(password), false, "bounded output exposed the synthetic credential");
  assert.equal(value.includes("�"), false);
  assert.ok(value.endsWith("[redacted]\nfinal reason"));
});

test("replacement markers and omission notices cannot reproduce short passwords", () => {
  for (const password of ["red", "[", "]", "a", "█", "\n", "a["]) {
    const value = capture(password, ["x".repeat(70000), password, password, " end"]);
    assert.equal(value.includes(password), false, "generated text reproduced a credential");
    assert.ok(Buffer.byteLength(value) <= 65536);
  }
});

test("retaining a possible password does not split unrelated Unicode characters", () => {
  assert.equal(capture("ab", ["😀", "🐈", "z"]), "😀🐈z");
});

test("final formatting protects normalized matches and reserves space for notices", () => {
  const password = "fixture-password";
  const value = "old context".repeat(200) + "fixture-\0password\nfinal reason";
  const formatted = redactCredentialText(value, password, { diagnostic: true, maxCharacters: 1200 });
  assert.equal(formatted.includes(password), false, "normalization exposed a credential");
  assert.ok(formatted.startsWith("[earlier output omitted]\n"));
  assert.ok(formatted.endsWith("[redacted]\nfinal reason"));
  assert.equal(Array.from(formatted).length, 1200);
  const unicode = redactCredentialText("😀".repeat(1201), password, { diagnostic: true, maxCharacters: 1200 });
  assert.equal(Array.from(unicode).length, 1200);
  assert.equal(unicode.includes("�"), false);
});

test("redaction remains intact at capture and diagnostic boundaries", () => {
  const password = "fixture-boundary";
  for (const padding of [1180, 1199, 1200, 1201, 65520, 65535, 65536, 65537]) {
    const value = capture(password, ["x".repeat(padding), password.slice(0, 6), password.slice(6), " tail"]);
    const diagnostic = redactCredentialText(value, password, { diagnostic: true, maxCharacters: 1200 });
    assert.equal(value.includes(password) || diagnostic.includes(password), false, "boundary exposed a credential");
    assert.ok(Buffer.byteLength(value) <= 65536);
    assert.ok(Array.from(diagnostic).length <= 1200);
    assert.ok(value.endsWith("[redacted] tail"));
    assert.ok(diagnostic.endsWith("[redacted] tail"));
  }
});

test("overlapping echoes, NUL credentials, and malformed final bytes remain protected", () => {
  for (const password of ["aaa", "aba", "a\0b", "[redacted]", "a[", "\n"]) {
    const bytes = Buffer.from(password.repeat(3));
    const value = capture(password, Array.from(bytes, byte => Buffer.from([byte])));
    assert.equal(value.includes(password), false, "repeated echo exposed a credential");
  }
  assert.equal(capture("�", [Buffer.from([0xe2, 0x82])]).includes("�"), false);
});

test("final trimming cannot expose an unfinished credential prefix", () => {
  for (const whitespace of ["\n", " ", "\r\n", "\t"]) {
    const value = capture("sunflower", ["failure: sunflo" + whitespace]);
    assert.equal(redactCredentialText(value, "sunflower", { trim: true }), "failure: [redacted]");
  }
});
