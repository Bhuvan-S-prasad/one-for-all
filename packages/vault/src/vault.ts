import {
  AppError,
  NotFoundError,
  type CredentialVault,
  type SecretInfo,
  type SecretRef,
  type TenantContext,
  type WorkspaceId,
} from "@ofa/core";
import {
  deleteSecret,
  findSecretById,
  findSecretByName,
  listEnvelopes,
  listSecrets,
  markSecretUsed,
  rewrapStoredEnvelope,
  upsertSecret,
  type Database,
  type SecretRecord,
  type StoredEnvelope,
} from "@ofa/db";
import {
  createKeyring,
  decryptEnvelope,
  encryptEnvelope,
  parseVaultKey,
  rewrapEnvelope,
  type Envelope,
} from "./crypto";
import { createRedactor, MIN_SECRET_LENGTH, type Redactor, type SecretRegistry } from "./redact";

export interface VaultOptions {
  readonly db: Database;
  /** The current vault key: 32 random bytes, base64 (`VAULT_KEY` or the OS keychain). */
  readonly key: string;
  /** Earlier keys, kept to read what they wrapped until rotation is done (`VAULT_PREVIOUS_KEYS`). */
  readonly previousKeys?: readonly string[];
  /** How long decrypted values are kept for redaction. Default 60 s. */
  readonly redactorTtlMs?: number;
  /** Learns every value the vault handles in plaintext, for logs and traces (M4.11). */
  readonly registry?: SecretRegistry;
  readonly now?: () => number;
}

/**
 * A record whose encrypted column is not a named secret: a connection's
 * tokens, or an MCP server's OAuth client. The ciphertext is bound to the
 * table, workspace and row, so it cannot be moved to another row.
 */
export interface RecordScope {
  readonly table: "connection" | "mcp_server";
  readonly id: string;
}

export interface RotationResult {
  /** Re-wrapped with the current key. */
  readonly rewrapped: number;
  /** Already on the current key. */
  readonly current: number;
  /** Wrapped by a key that is not configured; left as it was. */
  readonly unreadable: number;
}

/** `CredentialVault`, plus what connections need and key rotation (M4.02). */
export interface Vault extends CredentialVault {
  /** Encrypt a record's value, e.g. a connection's tokens as JSON. */
  seal(ctx: TenantContext, scope: RecordScope, value: string): Envelope;
  /** Decrypt a record's value. Only the tool executor and the MCP client call this (hard rule 4). */
  open(ctx: TenantContext, scope: RecordScope, envelope: Envelope): string;
  /** Re-wrap every value in the workspace that a previous key wrapped. */
  rotate(ctx: TenantContext): Promise<RotationResult>;
}

/** Lower case, digits, `.`, `_` and `-`: `llm.openrouter.api_key`. */
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** `last_used_at` is a hint for Settings, so it is written at most this often. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Fields of a record's JSON value that are secret and must be redacted. The
 * rest (token type, scopes, expiry, client name) is ordinary text.
 */
const SECRET_FIELDS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "registration_access_token",
  "code_verifier",
  "codeVerifier",
]);

/** Bind each ciphertext to its workspace and name, so it cannot be moved to another row. */
function aadFor(workspaceId: WorkspaceId, name: string): string {
  return `ofa:secret:${workspaceId}:${name}`;
}

function recordAad(workspaceId: WorkspaceId, scope: RecordScope): string {
  return `ofa:${scope.table}:${workspaceId}:${scope.id}`;
}

function storedAad(workspaceId: WorkspaceId, stored: StoredEnvelope): string {
  return stored.table === "secret"
    ? aadFor(workspaceId, stored.name ?? "")
    : recordAad(workspaceId, { table: stored.table, id: stored.id });
}

/** The values to redact from a record's plaintext: its secret fields, or all of it if it isn't JSON. */
export function secretsInRecord(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [value];
  }
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        if (SECRET_FIELDS.has(key) && typeof item === "string") found.push(item);
        else walk(item);
      }
    }
  };
  walk(parsed);
  return found;
}

function hintFor(value: string): string | null {
  return value.length >= 16 ? `…${value.slice(-4)}` : null;
}

function toInfo(record: SecretRecord): SecretInfo {
  return {
    id: record.id,
    name: record.name,
    hint: record.hint,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

/** `CredentialVault` backed by Postgres, encrypted with keys from the environment or the OS keychain. */
export function createVault(options: VaultOptions): Vault {
  const { db } = options;
  const keys = createKeyring(
    parseVaultKey(options.key),
    (options.previousKeys ?? []).map(parseVaultKey),
  );
  const ttl = options.redactorTtlMs ?? 60_000;
  const now = options.now ?? Date.now;
  // Decrypted values per workspace, for redaction. A replaced or deleted value
  // stays in the set until it expires: it may be in output from moments ago.
  const known = new Map<WorkspaceId, { values: Set<string>; redact: Redactor; expires: number }>();

  function decrypt(ctx: TenantContext, record: SecretRecord): string {
    return decryptEnvelope(keys, record, aadFor(ctx.workspaceId, record.name));
  }

  function remember(workspaceId: WorkspaceId, values: Set<string>, expires: number): Redactor {
    options.registry?.add(values);
    const redact = createRedactor(values);
    known.set(workspaceId, { values, redact, expires });
    return redact;
  }

  /** Redact these values from now on, without waiting for the cache to expire. */
  function learn(workspaceId: WorkspaceId, values: readonly string[]): void {
    const cached = known.get(workspaceId);
    if (cached) remember(workspaceId, new Set([...cached.values, ...values]), cached.expires);
  }

  async function redactorFor(ctx: TenantContext): Promise<Redactor> {
    const cached = known.get(ctx.workspaceId);
    if (cached && cached.expires > now()) return cached.redact;
    const values = new Set<string>();
    for (const stored of await listEnvelopes(db, ctx)) {
      // A value no configured key can open can't be revealed either, so it
      // can't reach output: skip it rather than fail every redaction.
      if (!keys.get(stored.keyId)) continue;
      const plain = decryptEnvelope(keys, stored, storedAad(ctx.workspaceId, stored));
      if (stored.table === "secret") values.add(plain);
      else for (const value of secretsInRecord(plain)) values.add(value);
    }
    return remember(ctx.workspaceId, values, now() + ttl);
  }

  return {
    async put(ctx, name, value) {
      if (!SECRET_NAME.test(name)) {
        throw new AppError("validation_failed", `Invalid secret name: ${name}`);
      }
      if (value.length < MIN_SECRET_LENGTH) {
        // Shorter values cannot be redacted reliably (ADR-0012).
        throw new AppError(
          "validation_failed",
          `Secrets must be at least ${MIN_SECRET_LENGTH} characters`,
        );
      }
      const envelope = encryptEnvelope(keys.current, value, aadFor(ctx.workspaceId, name));
      const record = await upsertSecret(db, ctx, { name, ...envelope, hint: hintFor(value) });
      learn(ctx.workspaceId, [value]);
      options.registry?.add([value]);
      return { id: record.id, name: record.name };
    },

    async find(ctx, name) {
      const record = await findSecretByName(db, ctx, name);
      return record ? { id: record.id, name: record.name } : null;
    },

    async list(ctx) {
      return (await listSecrets(db, ctx)).map(toInfo);
    },

    async reveal(ctx, ref: SecretRef) {
      const record = await findSecretById(db, ctx, ref.id);
      if (!record) throw new NotFoundError("Secret");
      const value = decrypt(ctx, record);
      options.registry?.add([value]);
      if (!record.lastUsedAt || now() - record.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
        await markSecretUsed(db, ctx, record.id);
      }
      return value;
    },

    async delete(ctx, ref) {
      await deleteSecret(db, ctx, ref.id);
    },

    async redact(ctx, text) {
      return (await redactorFor(ctx))(text);
    },

    seal(ctx, scope, value) {
      const envelope = encryptEnvelope(keys.current, value, recordAad(ctx.workspaceId, scope));
      learn(ctx.workspaceId, secretsInRecord(value));
      options.registry?.add(secretsInRecord(value));
      return envelope;
    },

    open(ctx, scope, envelope) {
      const value = decryptEnvelope(keys, envelope, recordAad(ctx.workspaceId, scope));
      options.registry?.add(secretsInRecord(value));
      return value;
    },

    async rotate(ctx) {
      let rewrapped = 0;
      let current = 0;
      let unreadable = 0;
      for (const stored of await listEnvelopes(db, ctx)) {
        if (stored.keyId === keys.currentId) {
          current += 1;
        } else if (!keys.get(stored.keyId)) {
          unreadable += 1;
        } else {
          const next = rewrapEnvelope(keys, stored, storedAad(ctx.workspaceId, stored));
          // False when the value was saved again meanwhile, so it is on the current key.
          if (await rewrapStoredEnvelope(db, ctx, stored, stored.keyId, next)) rewrapped += 1;
          else current += 1;
        }
      }
      return { rewrapped, current, unreadable };
    },
  };
}

/**
 * Stand-in when no vault key is configured: nothing can be stored or
 * revealed, and with nothing stored there is nothing to redact. The app still
 * starts, so first-run setup and login work before a key exists.
 */
export function createUnconfiguredVault(): CredentialVault {
  const refuse = async (): Promise<never> => {
    throw new AppError(
      "internal",
      "Secrets cannot be stored: VAULT_KEY is not set. Run infra/scripts/init-env.sh or add it to .env.",
    );
  };
  return {
    put: refuse,
    reveal: refuse,
    delete: refuse,
    find: async () => null,
    list: async () => [],
    redact: async (_ctx, text) => text,
  };
}
