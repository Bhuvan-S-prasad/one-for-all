import type { SecretId } from "../ids";
import type { TenantContext } from "../tenant";

export interface SecretRef {
  readonly id: SecretId;
  readonly name: string;
}

/**
 * Secrets are decrypted only inside the tool executor (ADR-0012) and never
 * appear in prompts, logs, traces or the sandbox.
 */
export interface CredentialVault {
  put(ctx: TenantContext, name: string, value: string): Promise<SecretRef>;
  reveal(ctx: TenantContext, ref: SecretRef): Promise<string>;
  delete(ctx: TenantContext, ref: SecretRef): Promise<void>;
  /** Replace every known secret value in `text` with `[REDACTED]`. */
  redact(ctx: TenantContext, text: string): Promise<string>;
}
