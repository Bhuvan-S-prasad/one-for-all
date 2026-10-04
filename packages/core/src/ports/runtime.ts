import type { AgentId, MessageId, RunId, ThreadId } from "../ids";
import type { RunContext, TenantContext } from "../tenant";
import type { ModelTier } from "./llm";
import type { MemoryScope } from "./memory";
import type { GrantMode, Verdict } from "./policy";
import type { ToolDescriptor } from "./tools";

// Ports the agent harness runs on (ARCHITECTURE.md §6). The harness sees only
// these; the composition root plugs in Inngest, Postgres and the tool
// executor (hard rule 1).

/**
 * Durable steps (ADR-0006). In production each call is an Inngest
 * `step.run`: it runs once, its result is memoized, and on replay the stored
 * result comes back without running `fn` again. Results must be plain JSON.
 */
export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface RunUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
}

export interface RunRecord {
  readonly id: RunId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId | null;
  readonly trigger: string;
  readonly status: RunStatus;
  readonly tainted: boolean;
  readonly usage: RunUsageTotals;
}

export interface RunPatch {
  /**
   * Leave a run that already ended (succeeded, failed or cancelled) as it is,
   * e.g. when a normal finish races a cancellation.
   */
  readonly onlyIfActive?: boolean;
  /** Apply only while the run has this status (e.g. `waiting` → `running`). */
  readonly onlyIfStatus?: RunStatus;
  readonly status?: RunStatus;
  readonly tainted?: boolean;
  readonly usage?: RunUsageTotals;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly startedAt?: Date;
  readonly endedAt?: Date;
}

/**
 * Key prefix for the learning pass that runs after a run succeeded (memory
 * extraction). Only these events may join a run's log after `run.ended`.
 */
export const LEARN_EVENT_PREFIX = "learn-";

/** One entry for the append-only run log (ADR-0014). */
export interface RunEventWrite {
  /**
   * Unique within the run and stable across retries (`model-3`, `tool-3-0`),
   * so a retried step does not write the same event twice.
   */
  readonly key: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface RunStore {
  get(ctx: TenantContext, runId: RunId): Promise<RunRecord | null>;
  update(ctx: TenantContext, runId: RunId, patch: RunPatch): Promise<void>;
  /**
   * Append events in order; the store assigns each a `seq`. Events whose key
   * the run already has are skipped. Once the run has ended, only `run.ended`
   * is accepted, plus `learn-` events if it succeeded.
   */
  append(ctx: TenantContext, runId: RunId, events: readonly RunEventWrite[]): Promise<void>;
}

// ── Agents and threads ───────────────────────────────────────────────────────

export interface AgentGrantRule {
  /** A tool name or an app wildcard (`hubspot.*`). */
  readonly tool: string;
  readonly mode: GrantMode;
}

/** What the harness needs to know about an agent. */
export interface AgentProfile {
  readonly id: AgentId;
  readonly slug: string;
  readonly name: string;
  /** Standing rules, always in context. */
  readonly description: string;
  readonly status: "active" | "paused" | "archived";
  readonly job: string;
  readonly modelTier: ModelTier;
  readonly autonomy: string;
  readonly voice: string;
  readonly memoryScopes: readonly MemoryScope[];
  readonly budgets: {
    readonly steps: number;
    readonly tokens: number;
    readonly costUsd?: number;
  };
  readonly grants: readonly AgentGrantRule[];
}

export interface AgentDirectory {
  get(ctx: TenantContext, agentId: AgentId): Promise<AgentProfile | null>;
}

export interface ConversationMessage {
  readonly id: MessageId;
  readonly author: "user" | "agent" | "system";
  readonly agentId: AgentId | null;
  readonly content: string;
  readonly createdAt: Date;
}

export interface ThreadStore {
  /** The latest `limit` messages, oldest first. */
  recentMessages(
    ctx: TenantContext,
    threadId: ThreadId,
    limit: number,
  ): Promise<ConversationMessage[]>;
  addAgentMessage(
    ctx: RunContext,
    input: { readonly threadId: ThreadId; readonly content: string },
  ): Promise<MessageId>;
}

// ── Tool execution ───────────────────────────────────────────────────────────

export interface ToolExecutionRequest {
  readonly name: string;
  readonly args: unknown;
  /** Stable within the run, e.g. `tool-3-0`. */
  readonly toolCallId: string;
  /** `runId:step`, stable across retries (ADR-0015). */
  readonly idempotencyKey: string;
  /** The run has read untrusted content (ADR-0013). */
  readonly tainted: boolean;
}

export type ToolOutcome =
  | {
      readonly status: "ok";
      /** What the model reads: redacted, size-limited text. */
      readonly content: string;
      /** The content came from outside the system; the run becomes tainted. */
      readonly untrusted: boolean;
      readonly verdict: Verdict;
      readonly reasons: readonly string[];
      readonly durationMs: number;
    }
  | {
      /** Policy said no, or that a person must approve first. Nothing ran. */
      readonly status: "blocked";
      readonly verdict: Verdict;
      readonly reasons: readonly string[];
      readonly message: string;
    }
  | {
      readonly status: "error";
      readonly code: string;
      readonly message: string;
      readonly verdict?: Verdict;
      readonly reasons?: readonly string[];
      readonly durationMs: number;
    };

/** Lists the tools an agent may use and runs them through policy (hard rule 5). */
export interface ToolExecutor {
  listTools(ctx: RunContext): Promise<ToolDescriptor[]>;
  execute(request: ToolExecutionRequest, ctx: RunContext): Promise<ToolOutcome>;
}

export interface ToolCallRecord {
  readonly status: "in_flight" | "done" | "failed";
  readonly result: unknown;
  readonly untrusted: boolean;
}

/** The `tool_call` table: exactly-once bookkeeping (ADR-0015). */
export interface ToolCallStore {
  /** Record `in_flight`. If the key exists, nothing is written and the existing row is returned. */
  begin(
    ctx: RunContext,
    input: {
      readonly idempotencyKey: string;
      readonly tool: string;
      readonly args: unknown;
      readonly verdict: Verdict;
    },
  ): Promise<
    { readonly created: true } | { readonly created: false; readonly existing: ToolCallRecord }
  >;
  complete(
    ctx: RunContext,
    idempotencyKey: string,
    outcome: { readonly result: unknown; readonly untrusted: boolean },
  ): Promise<void>;
  fail(
    ctx: RunContext,
    idempotencyKey: string,
    error: { readonly code: string; readonly message: string },
  ): Promise<void>;
}
