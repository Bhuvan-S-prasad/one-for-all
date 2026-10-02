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
  listSecrets,
  markSecretUsed,
  upsertSecret,
  type Database,
  type SecretRecord,
} from "@ofa/db";
import { decryptEnvelope, encryptEnvelope, parseVaultKey } from "./crypto";
import { createRedactor, MIN_SECRET_LENGTH, type Redactor } from "./redact";

export interface VaultOptions {
  readonly db: Database;
  /** `VAULT_KEY`: 32 random bytes, base64. */
  readonly key: string;
  /** How long decrypted values are kept for redaction. Default 60 s. */
  readonly redactorTtlMs?: number;
  readonly now?: () => number;
}

/** Lower case, digits, `.`, `_` and `-`: `llm.openrouter.api_key`. */
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** `last_used_at` is a hint for Settings, so it is written at most this often. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Bind each ciphertext to its workspace and name, so it cannot be moved to another row. */
function aadFor(workspaceId: WorkspaceId, name: string): string {
  return `ofa:secret:${workspaceId}:${name}`;
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

/** `CredentialVault` backed by Postgres, encrypted with a key from the environment. */
export function createVault(options: VaultOptions): CredentialVault {
  const { db } = options;
  const key = parseVaultKey(options.key);
  const ttl = options.redactorTtlMs ?? 60_000;
  const now = options.now ?? Date.now;
  // Decrypted values per workspace, for redaction. A replaced or deleted value
  // stays in the set until it expires: it may be in output from moments ago.
  const known = new Map<WorkspaceId, { values: Set<string>; redact: Redactor; expires: number }>();

  function decrypt(ctx: TenantContext, record: SecretRecord): string {
    return decryptEnvelope(key, record, aadFor(ctx.workspaceId, record.name));
  }

  function remember(workspaceId: WorkspaceId, values: Set<string>, expires: number): Redactor {
    const redact = createRedactor(values);
    known.set(workspaceId, { values, redact, expires });
    return redact;
  }

  async function redactorFor(ctx: TenantContext): Promise<Redactor> {
    const cached = known.get(ctx.workspaceId);
    if (cached && cached.expires > now()) return cached.redact;
    const records = await listSecrets(db, ctx);
    const values = new Set(records.map((record) => decrypt(ctx, record)));
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
      const envelope = encryptEnvelope(key, value, aadFor(ctx.workspaceId, name));
      const record = await upsertSecret(db, ctx, { name, ...envelope, hint: hintFor(value) });
      // Redact the new value from now on, without waiting for the cache to expire.
      const cached = known.get(ctx.workspaceId);
      if (cached) remember(ctx.workspaceId, new Set([...cached.values, value]), cached.expires);
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
  };
}

/**
 * Stand-in when `VAULT_KEY` is not set: nothing can be stored or revealed,
 * and with nothing stored there is nothing to redact. The app still starts,
 * so first-run setup and login work before a key exists.
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
