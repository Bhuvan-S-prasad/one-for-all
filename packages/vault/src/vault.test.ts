import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRedactor,
  decryptEnvelope,
  encryptEnvelope,
  parseVaultKey,
  REDACTED,
  redactSecrets,
  redactValue,
  VaultKeyError,
} from "./index";

// Throwaway keys made per test run; never a real secret.
const key = randomBytes(32);
const otherKey = randomBytes(32);
const aad = "ofa:secret:ws_1:llm.test.api_key";

describe("envelope encryption", () => {
  it("round-trips a value and never stores it in the clear", () => {
    const value = "test-value-not-a-real-key-0001";
    const envelope = encryptEnvelope(key, value, aad);
    expect(JSON.stringify(envelope)).not.toContain(value);
    expect(decryptEnvelope(key, envelope, aad)).toBe(value);
  });

  it("uses a fresh data key and IV each time", () => {
    const a = encryptEnvelope(key, "same-value-1234", aad);
    const b = encryptEnvelope(key, "same-value-1234", aad);
    expect(a.valueCiphertext).not.toBe(b.valueCiphertext);
    expect(a.keyCiphertext).not.toBe(b.keyCiphertext);
  });

  it("refuses a different vault key with a clear error", () => {
    const envelope = encryptEnvelope(key, "value-12345678", aad);
    expect(() => decryptEnvelope(otherKey, envelope, aad)).toThrow(VaultKeyError);
  });

  it("refuses a ciphertext moved to another workspace or name", () => {
    const envelope = encryptEnvelope(key, "value-12345678", aad);
    expect(() => decryptEnvelope(key, envelope, "ofa:secret:ws_2:llm.test.api_key")).toThrow();
  });

  it("detects tampering", () => {
    const envelope = encryptEnvelope(key, "value-12345678", aad);
    const parts = envelope.valueCiphertext.split(".");
    const flipped = Buffer.from(parts[3] ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    parts[3] = flipped.toString("base64url");
    expect(() =>
      decryptEnvelope(key, { ...envelope, valueCiphertext: parts.join(".") }, aad),
    ).toThrow();
  });

  it("checks the vault key length", () => {
    expect(() => parseVaultKey(Buffer.alloc(16).toString("base64"))).toThrow(VaultKeyError);
    expect(parseVaultKey(key.toString("base64"))).toHaveLength(32);
  });
});

describe("redaction", () => {
  const secret = "test-token-a1b2c3d4";

  it("replaces a secret wherever it appears", () => {
    expect(redactSecrets(`Bearer ${secret} and again ${secret}`, [secret])).toBe(
      `Bearer ${REDACTED} and again ${REDACTED}`,
    );
  });

  it("catches JSON-escaped and URL-encoded forms", () => {
    const tricky = 'pa"ss/word+1';
    const redact = createRedactor([tricky]);
    expect(redact(JSON.stringify({ password: tricky }))).toBe(`{"password":"${REDACTED}"}`);
    expect(redact(`?pw=${encodeURIComponent(tricky)}`)).toBe(`?pw=${REDACTED}`);
  });

  it("replaces the longer of two overlapping secrets whole", () => {
    expect(redactSecrets("key=abcdefgh-ijkl", ["abcdefgh", "abcdefgh-ijkl"])).toBe(
      `key=${REDACTED}`,
    );
  });

  it("ignores values shorter than the minimum", () => {
    expect(redactSecrets("the cat sat", ["cat"])).toBe("the cat sat");
  });

  it("walks nested values, keys included", () => {
    const redact = createRedactor([secret]);
    expect(
      redactValue({ headers: [{ authorization: `Bearer ${secret}` }], [secret]: 1, n: 2 }, redact),
    ).toEqual({ headers: [{ authorization: `Bearer ${REDACTED}` }], [REDACTED]: 1, n: 2 });
  });
});
