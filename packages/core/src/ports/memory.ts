import type { MemoryId } from "../ids";
import type { RunContext, TenantContext } from "../tenant";

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

export interface MemoryStore extends Partial<EpisodeStore> {
  write(ctx: TenantContext, memory: MemoryWrite): Promise<MemoryRecord>;
  recall(ctx: TenantContext, query: RecallQuery): Promise<MemoryRecord[]>;
}

/** How a run ended, as its episode says (M5.09). */
export type EpisodeOutcome = "done" | "stopped" | "failed";

export interface EpisodeWrite {
  readonly threadId: string | null;
  /** What was asked and what came of it, in a sentence or two. */
  readonly summary: string;
  readonly outcome: EpisodeOutcome;
  /** The run read outside content. */
  readonly tainted: boolean;
}

export interface EpisodeRecord {
  readonly runId: string;
  readonly summary: string;
  readonly outcome: EpisodeOutcome;
  readonly createdAt: Date;
}

/**
 * Episodic memory (ARCHITECTURE.md §8, M5.09): one episode per run that
 * replied, written as the run ends and replaced by the learning pass's
 * summary. Recall finds earlier work like the current request.
 */
export interface EpisodeStore {
  /** The run's episode (one per run; a second write replaces the summary). */
  writeEpisode(ctx: RunContext, episode: EpisodeWrite): Promise<void>;
  /** This agent's past episodes for this person that match, best first; tainted ones never. */
  recallEpisodes(
    ctx: RunContext,
    query: { readonly query: string; readonly limit: number },
  ): Promise<EpisodeRecord[]>;
}

// ── Nightly consolidation (M5.09) ────────────────────────────────────────────

/** A workspace whose memory is due for its nightly pass, and its owner (the pass acts as them). */
export interface DueConsolidation {
  readonly workspaceId: string;
  readonly userId: string;
}

/** What one nightly pass did. */
export interface ConsolidationResult {
  readonly merged: number;
  readonly added: number;
  readonly expired: number;
  readonly proposedSkills: number;
  readonly modelCalls: number;
}

export interface ConsolidationFact {
  readonly id: string;
  readonly content: string;
  readonly verified: boolean;
}

export interface ConsolidationEpisode {
  readonly summary: string;
  readonly outcome: EpisodeOutcome;
}

/**
 * The rows nightly consolidation reads and changes. The harness decides what
 * to merge, add and propose (one model call per agent); this keeps the rules
 * that need no model: duplicates, unconfirmed and unused facts expire.
 */
export interface MemoryMaintenance {
  /** Workspaces where it is about 3 at night and the last pass is most of a day old. */
  listDue(now: Date): Promise<DueConsolidation[]>;
  /** Agents with facts of their own or episodes not yet read. */
  agents(ctx: TenantContext): Promise<string[]>;
  /** One agent's own facts, or (null) the shared workspace facts, newest first. */
  facts(ctx: TenantContext, agentId: string | null, limit: number): Promise<ConsolidationFact[]>;
  /** The agent's untainted episodes not yet read, oldest first. */
  newEpisodes(ctx: TenantContext, agentId: string, limit: number): Promise<ConsolidationEpisode[]>;
  /** Replace facts with one; verified only if all of them were. */
  merge(
    ctx: TenantContext,
    input: {
      readonly agentId: string | null;
      readonly ids: readonly string[];
      readonly content: string;
      readonly now: Date;
    },
  ): Promise<boolean>;
  /** A new fact in the agent's own memory (or, with null, the workspace's). */
  addFact(
    ctx: TenantContext,
    input: {
      readonly agentId: string | null;
      readonly content: string;
      readonly verified: boolean;
    },
  ): Promise<void>;
  /** A skill proposed for a person to approve; false if its handle is taken. */
  proposeSkill(
    ctx: TenantContext,
    input: {
      readonly agentId: string;
      readonly name: string;
      readonly description: string;
      readonly steps: readonly string[];
    },
  ): Promise<boolean>;
  /** Expire duplicates, unconfirmed and unused facts; how many expired. */
  expireStale(ctx: TenantContext, now: Date): Promise<number>;
  /** Mark the agent's episodes read, and drop very old ones. */
  closeEpisodes(ctx: TenantContext, agentId: string, now: Date): Promise<void>;
  /** The workspace's pass is done. */
  finish(ctx: TenantContext, now: Date): Promise<void>;
}
