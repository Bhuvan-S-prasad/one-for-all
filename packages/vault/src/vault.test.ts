import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKeyring,
  createRedactor,
  createSecretRegistry,
  decryptEnvelope,
  encryptEnvelope,
  parseVaultKey,
  REDACTED,
  redactSecrets,
  redactValue,
  rewrapEnvelope,
  secretsInRecord,
  VaultKeyError,
} from "./index";

// Throwaway keys made per test run; never a real secret.
const key = randomBytes(32);
const otherKey = randomBytes(32);
const aad = "ofa:secret:ws_1:llm.test.api_key";
const keys = createKeyring(key);

describe("envelope encryption", () => {
  it("round-trips a value and never stores it in the clear", () => {
    const value = "test-value-not-a-real-key-0001";
    const envelope = encryptEnvelope(key, value, aad);
    expect(JSON.stringify(envelope)).not.toContain(value);
    expect(decryptEnvelope(keys, envelope, aad)).toBe(value);
  });

  it("uses a fresh data key and IV each time", () => {
    const a = encryptEnvelope(key, "same-value-1234", aad);
    const b = encryptEnvelope(key, "same-value-1234", aad);
    expect(a.valueCiphertext).not.toBe(b.valueCiphertext);
    expect(a.keyCiphertext).not.toBe(b.keyCiphertext);
  });

  it("refuses a different vault key with a clear error", () => {
    const envelope = encryptEnvelope(key, "value-12345678", aad);
    expect(() => decryptEnvelope(createKeyring(otherKey), envelope, aad)).toThrow(VaultKeyError);
  });

  it("refuses a ciphertext moved to another workspace or name", () => {
    const envelope = encryptEnvelope(key, "value-12345678", aad);
    expect(() => decryptEnvelope(keys, envelope, "ofa:secret:ws_2:llm.test.api_key")).toThrow();
  });

  it("detects tampering", () => {
    const envelope = encryptEnvelope(key, "value-12345678", aad);
    const parts = envelope.valueCiphertext.split(".");
    const flipped = Buffer.from(parts[3] ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    parts[3] = flipped.toString("base64url");
    expect(() =>
      decryptEnvelope(keys, { ...envelope, valueCiphertext: parts.join(".") }, aad),
    ).toThrow();
  });

  it("checks the vault key length", () => {
    expect(() => parseVaultKey(Buffer.alloc(16).toString("base64"))).toThrow(VaultKeyError);
    expect(parseVaultKey(key.toString("base64"))).toHaveLength(32);
  });
});

describe("key rotation", () => {
  it("reads values a previous key wrapped", () => {
    const envelope = encryptEnvelope(otherKey, "value-12345678", aad);
    expect(decryptEnvelope(createKeyring(key, [otherKey]), envelope, aad)).toBe("value-12345678");
  });

  it("re-wraps only the data key, after which the old key is not needed", () => {
    const envelope = encryptEnvelope(otherKey, "value-12345678", aad);
    const rotating = createKeyring(key, [otherKey]);
    const rewrapped = rewrapEnvelope(rotating, envelope, aad);
    expect(rewrapped.valueCiphertext).toBe(envelope.valueCiphertext);
    expect(rewrapped.keyCiphertext).not.toBe(envelope.keyCiphertext);
    expect(rewrapped.keyId).toBe(rotating.currentId);
    expect(decryptEnvelope(keys, rewrapped, aad)).toBe("value-12345678");
    // Already current: returned as it is.
    expect(rewrapEnvelope(rotating, rewrapped, aad)).toBe(rewrapped);
  });

  it("keeps the binding while re-wrapping", () => {
    const envelope = encryptEnvelope(otherKey, "value-12345678", aad);
    expect(() =>
      rewrapEnvelope(createKeyring(key, [otherKey]), envelope, "ofa:secret:ws_2:other"),
    ).toThrow();
  });

  it("lists previous keys once, and never the current one", () => {
    const ring = createKeyring(key, [otherKey, otherKey, key]);
    expect(ring.previousIds).toHaveLength(1);
    expect(ring.get(ring.previousIds[0] ?? "")).toBe(otherKey);
  });
});

describe("record values", () => {
  it("redacts the secret fields of a token set, not its ordinary ones", () => {
    const tokens = JSON.stringify({
      access_token: "access-0000-1111",
      refresh_token: "refresh-2222-3333",
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/gmail.compose",
      client: { client_id: "public-id-123", client_secret: "client-secret-4444" },
    });
    expect(secretsInRecord(tokens).sort()).toEqual([
      "access-0000-1111",
      "client-secret-4444",
      "refresh-2222-3333",
    ]);
  });

  it("treats a value that isn't JSON as one secret", () => {
    expect(secretsInRecord("plain-secret-value")).toEqual(["plain-secret-value"]);
  });
});

describe("secret registry", () => {
  it("redacts every value it was given, and ignores short or empty ones", () => {
    const registry = createSecretRegistry();
    expect(registry.redact("nothing yet")).toBe("nothing yet");
    registry.add(["first-secret-01", undefined, null, "short"]);
    registry.add(["second-secret-02", "first-secret-01"]);
    expect(registry.redact("first-secret-01 second-secret-02 short")).toBe(
      `${REDACTED} ${REDACTED} short`,
    );
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
