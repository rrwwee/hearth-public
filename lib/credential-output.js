import { StringDecoder } from "node:string_decoder";

const outputLimit = 65536;

function credentialRedaction(password) {
  if (typeof password !== "string" || !password) throw new TypeError("A nonempty credential is required.");
  // A character absent from the password cannot form a match at a join.
  let codePoint = 0x2588;
  while (password.includes(String.fromCodePoint(codePoint))) codePoint++;
  const barrier = String.fromCodePoint(codePoint);
  const marker = !password.includes("[") && !password.includes("]") && !"[redacted]".includes(password)
    ? "[redacted]" : barrier;
  function replace(value, maskSuffix = false) {
    let text = value.replaceAll(password, marker);
    if (maskSuffix) {
      for (let length = Math.min(text.length, password.length - 1); length > 0; length--) {
        if (text.endsWith(password.slice(0, length))) {
          text = text.slice(0, -length) + marker;
          break;
        }
      }
    }
    return text;
  }
  const boundary = password.includes("\n") ? barrier : "\n";
  return { marker, replace, notice: replace("[earlier output omitted]") + boundary };
}

function byteTail(bytes, limit) {
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return Buffer.from(bytes.subarray(start));
}

function formatText(value, redaction, { diagnostic = false, maxCharacters, omitted = false, trim = false, maskSuffix = trim } = {}) {
  // Match the text representation that leaves the process, including malformed
  // surrogate replacement and the diagnostic log's NUL normalization.
  let text = Buffer.from(String(value ?? "")).toString("utf8");
  if (diagnostic) text = text.replaceAll("\u0000", "");
  if (trim) text = text.trim();
  text = redaction.replace(text, maskSuffix);
  const characters = Array.from(text);
  omitted ||= Buffer.byteLength(text) > outputLimit || (maxCharacters !== undefined && characters.length > maxCharacters);
  const notice = omitted ? redaction.notice : "";
  if (maxCharacters !== undefined) {
    const available = Math.max(0, maxCharacters - Array.from(notice).length);
    text = available ? characters.slice(-available).join("") : "";
  }
  return notice + byteTail(Buffer.from(text), outputLimit - Buffer.byteLength(notice)).toString("utf8");
}

// Also guard generated messages and text after the caller's final formatting.
export function redactCredentialText(value, password, options) {
  return formatText(value, credentialRedaction(password), options);
}

// A stream keeps enough undecided text to recognize a password split over writes.
export function createCredentialOutput(password) {
  const redaction = credentialRedaction(password);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let text = Buffer.alloc(0);
  let omitted = false;
  function append(value) {
    const combined = Buffer.concat([text, Buffer.from(value)]);
    omitted ||= combined.length > outputLimit;
    text = byteTail(combined, outputLimit);
  }
  function accept(value) {
    pending += value;
    const parts = [];
    let index;
    while ((index = pending.indexOf(password)) !== -1) {
      parts.push(pending.slice(0, index), redaction.marker);
      pending = pending.slice(index + password.length);
    }
    let safeLength = Math.max(0, pending.length - password.length + 1);
    if (safeLength > 0 && pending.codePointAt(safeLength - 1) > 0xffff) safeLength--;
    parts.push(pending.slice(0, safeLength));
    append(parts.join(""));
    pending = pending.slice(safeLength);
  }
  return {
    write(chunk) {
      for (let offset = 0; offset < chunk.length; offset += 4096) {
        accept(decoder.write(chunk.subarray(offset, offset + 4096)));
      }
    },
    finish() {
      accept(decoder.end());
      append(redaction.replace(pending, true));
      pending = "";
      return formatText(text.toString("utf8"), redaction, { omitted });
    },
  };
}
