import type { MemoryId } from "../ids";
import type { TenantContext } from "../tenant";

/** workspace: team knowledge · agent: role context · agent_user: private per-person notes. */
export type MemoryScope = "workspace" | "agent" | "agent_user";
export type MemoryKind = "fact" | "preference" | "episode";

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
