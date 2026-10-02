import type { MemoryId } from "../ids";
import type { TenantContext } from "../tenant";

/** workspace: team knowledge · agent: role context · agent_user: private per-person notes. */
export const MEMORY_SCOPES = ["workspace", "agent", "agent_user"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = ["fact", "preference", "episode"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryWrite {
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
  /** False when learned during a tainted run; not preloaded until confirmed. */
  readonly verified: boolean;
}

export interface MemoryRecord extends MemoryWrite {
  readonly id: MemoryId;
  readonly createdAt: Date;
}

export interface RecallQuery {
  readonly query: string;
  readonly scopes: readonly MemoryScope[];
  readonly limit: number;
  readonly includeUnverified?: boolean;
}

export interface MemoryStore {
  write(ctx: TenantContext, memory: MemoryWrite): Promise<MemoryRecord>;
  recall(ctx: TenantContext, query: RecallQuery): Promise<MemoryRecord[]>;
}
