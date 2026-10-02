import type { SecretId } from "../ids";
import type { TenantContext } from "../tenant";

export interface SecretRef {
  readonly id: SecretId;
  readonly name: string;
}

/** What may be shown about a secret: never its value. */
export interface SecretInfo extends SecretRef {
  /** Last four characters (`…a1b2`) when the value is long enough, else null. */
  readonly hint: string | null;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
}

/**
 * Secrets are decrypted only where they are used (ADR-0012): the tool
 * executor, and the model gateway for the model provider's API key. They never
 * appear in prompts, logs, traces or the sandbox.
 */
export interface CredentialVault {
  /** Store a value under `name`, replacing any existing value. */
  put(ctx: TenantContext, name: string, value: string): Promise<SecretRef>;
  find(ctx: TenantContext, name: string): Promise<SecretRef | null>;
  list(ctx: TenantContext): Promise<SecretInfo[]>;
  reveal(ctx: TenantContext, ref: SecretRef): Promise<string>;
  delete(ctx: TenantContext, ref: SecretRef): Promise<void>;
  /** Replace every known secret value in `text` with `[REDACTED]`. */
  redact(ctx: TenantContext, text: string): Promise<string>;
}
