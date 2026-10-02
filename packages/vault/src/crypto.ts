import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// AES-256-GCM envelope encryption (ADR-0012). Each secret gets a fresh data
// key; the data key is encrypted ("wrapped") with the vault key from the
// environment. Rotating the vault key then means re-wrapping small data keys,
// not re-encrypting every value.
//
// Sealed format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url.

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyError";
  }
}

/** Decode `VAULT_KEY` (32 random bytes, base64) and check its length. */
export function parseVaultKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new VaultKeyError("VAULT_KEY must be 32 random bytes encoded as base64");
  }
  return key;
}

/**
 * A stable, non-secret fingerprint of a vault key. Stored next to each
 * wrapped data key so a changed `VAULT_KEY` gives a clear error instead of a
 * generic decryption failure.
 */
export function keyFingerprint(key: Buffer): string {
  return createHmac("sha256", key).update("ofa-vault-key-id").digest("hex").slice(0, 16);
}

/** Encrypt `plaintext`. `aad` is authenticated but not stored; the same value must be given to open. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/** Decrypt a value from `seal`. Throws if it was tampered with or the key or `aad` differ. */
export function open(key: Buffer, sealed: string, aad: string): Buffer {
  const [version, iv, tag, ciphertext, extra] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined || extra !== undefined) {
    throw new Error("Unrecognised ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
}

export interface Envelope {
  readonly valueCiphertext: string;
  readonly keyCiphertext: string;
  readonly keyId: string;
}

/** Encrypt a value with a fresh data key, and wrap that key with the vault key. */
export function encryptEnvelope(vaultKey: Buffer, value: string, aad: string): Envelope {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    return {
      valueCiphertext: seal(dataKey, Buffer.from(value, "utf8"), aad),
      keyCiphertext: seal(vaultKey, dataKey, `${aad}#key`),
      keyId: keyFingerprint(vaultKey),
    };
  } finally {
    dataKey.fill(0);
  }
}

export function decryptEnvelope(vaultKey: Buffer, envelope: Envelope, aad: string): string {
  if (envelope.keyId !== keyFingerprint(vaultKey)) {
    throw new VaultKeyError(
      "This secret was stored with a different VAULT_KEY. Restore the original key, or save the secret again.",
    );
  }
  const dataKey = open(vaultKey, envelope.keyCiphertext, `${aad}#key`);
  try {
    return open(dataKey, envelope.valueCiphertext, aad).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}
