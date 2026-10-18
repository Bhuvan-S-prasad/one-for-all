import type { AgentId, MessageId, RunId, ThreadId } from "../ids";
import type { RunContext, TenantContext } from "../tenant";
import type { LLMImage, ModelTier } from "./llm";
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
  /**
   * Wait, holding no process, for an event whose `data[field]` equals `value`
   * (Inngest `step.waitForEvent`). Resolves with the event's data, or null
   * after `timeoutMs`. Only events sent after the wait starts count. Absent
   * where runs cannot wait (then nothing that needs a person can run).
   */
  waitForEvent?(
    id: string,
    options: {
      readonly event: string;
      readonly field: string;
      readonly value: string;
      readonly timeoutMs: number;
    },
  ): Promise<Record<string, unknown> | null>;
  /**
   * Run a handoff's child run and wait, holding no process, for it to end
   * (Inngest `step.invoke`, M5.01). Resolves with what it came to, or null
   * when it failed or ran past `timeoutMs`. Several started together run at
   * the same time. Absent where runs can't start children (then delegation is
   * refused).
   */
  invokeRun?(
    id: string,
    child: ChildRunRequest,
    options: { readonly timeoutMs: number },
  ): Promise<ChildRunResult | null>;
}

/** The child run of a handoff (see `TeamDirectory.handoff`). */
export interface ChildRunRequest {
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  /** The brief that starts it. */
  readonly messageId: MessageId;
}

/** What a child run came to. */
export interface ChildRunResult {
  readonly status: "succeeded" | "failed" | "cancelled" | "skipped";
  readonly stopReason: string | null;
  /** Its reply, as posted to the handoff thread. */
  readonly reply: string | null;
  /** It read outside content, so its reply may carry someone else's words. */
  readonly tainted: boolean;
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
  /** A proactive check (M5.10): only tools that change nothing may run. */
  readonly proactive?: boolean;
  /** What a run without a request message was asked: a check's instructions. */
  readonly request?: string | null;
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
  /** Runs this run handed work to that haven't ended, so Stop stops them too (M5.01). */
  activeChildren?(ctx: TenantContext, runId: RunId): Promise<RunId[]>;
  /**
   * Steering (M5.05): what the person wrote in this run's thread since it
   * started, still waiting for this agent. Their queued runs end as
   * `steered`, so the messages are answered once, by this run. Oldest first.
   */
  claimFollowUps?(
    ctx: RunContext,
    threadId: ThreadId,
  ): Promise<{ readonly id: MessageId; readonly content: string }[]>;
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
  /** A coordinator plans and hands work to its team (ADR-0044). Absent means specialist. */
  readonly role?: "specialist" | "coordinator";
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
  /** A group thread's coordinator, who acts as one there (ADR-0044); null elsewhere. */
  coordinatorOf?(ctx: TenantContext, threadId: ThreadId): Promise<AgentId | null>;
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

// ── The chat record (ADR-0045) ───────────────────────────────────────────────

/** One thing an agent did in a chat, in the harness's words (ADR-0045). */
export interface ChatLedgerEntry {
  /** `action` changed something; `handoff` went to another agent; `search` and `read` looked. */
  readonly kind: "action" | "handoff" | "search" | "read";
  readonly text: string;
  /** Quotes outside content (a tainted child's answer): shown wrapped, and taints the run that loads it. */
  readonly untrusted?: boolean;
  /** The run that did it. */
  readonly runId: string;
}

export interface ChatPlanItem {
  readonly text: string;
  readonly done: boolean;
}

/**
 * An agent's working record in one chat: what the next run there needs to
 * carry on instead of starting over. Rewritten as each run goes.
 */
export interface ChatRecord {
  /** The latest plan (`todo.write`), or none. */
  readonly plan: readonly ChatPlanItem[] | null;
  /** What was done, oldest first; the latest entries only. */
  readonly ledger: readonly ChatLedgerEntry[];
  /** Notes from compacted steps, if a run had any. */
  readonly notes: string | null;
  /** How the run that last wrote it ended; null while it runs, or if it never got to say (failed, stopped). */
  readonly stopReason: string | null;
  /** The run that last wrote it. */
  readonly runId: string;
  /** A run that wrote it had read outside content: its addresses don't count as given (ADR-0027). */
  readonly tainted: boolean;
}

/** One record per chat and agent; `ctx.agentId` picks the agent. */
export interface ChatRecordStore {
  get(ctx: RunContext, threadId: ThreadId): Promise<ChatRecord | null>;
  save(ctx: RunContext, threadId: ThreadId, record: ChatRecord): Promise<void>;
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
  /**
   * A person approved this exact call (its approval was decided). Lets an
   * `approve` or `human` verdict run; never loosens a `deny`.
   */
  readonly approved?: boolean;
  /** Addresses the run was given so far (`urlKey` form), for the provenance check (§10.3). */
  readonly knownUrls?: readonly string[];
  /** Sites a person allowed for the rest of this run (see `PolicyInput.allowedSites`). */
  readonly allowedSites?: readonly string[];
  /** A proactive check (see `PolicyInput.readOnly`). */
  readonly readOnly?: boolean;
}

export type ToolOutcome =
  | {
      readonly status: "ok";
      /** What the model reads: redacted, size-limited text. */
      readonly content: string;
      /** The content came from outside the system; the run becomes tainted. */
      readonly untrusted: boolean;
      /** Long output kept as an artifact (the content says how to reopen it), or a file kept for people. */
      readonly artifactId?: string;
      /** A screenshot the model is shown after this result (DT.11); the run keeps it as an artifact. */
      readonly image?: LLMImage;
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
      /** For `approve` and `human`: what the call would do, in plain words, for the person deciding. */
      readonly summary?: string;
      /** The site a person may allow for the rest of the run instead (see `PolicyDecision.allowSite`). */
      readonly allowSite?: string;
      /** Top-level text arguments the person may change before approving (ADR-0030). */
      readonly editable?: readonly string[];
      /** The card should list the call's arguments: the summary doesn't say them. */
      readonly showArgs?: boolean;
    }
  | {
      readonly status: "error";
      readonly code: string;
      readonly message: string;
      readonly verdict?: Verdict;
      readonly reasons?: readonly string[];
      readonly durationMs: number;
    };

/**
 * A tool `load_toolkit` picked from an app, by its full name, however the
 * model wrote it: `create_pages`, `notion.create_pages` or `notion_create_pages`.
 */
export function toolkitToolName(app: string, tool: string): string {
  const name = tool.trim().toLowerCase();
  for (const sep of [".", "_"]) {
    if (name.startsWith(`${app}${sep}`)) return `${app}.${name.slice(app.length + 1)}`;
  }
  return `${app}.${name}`;
}

/**
 * What an agent can do in one area (an app, or a group of built-in tools),
 * in plain words, from its grants (ADR-0044): `web: search, read pages`.
 */
export interface AgentCapability {
  readonly area: string;
  /** What it can do there; `(asks first)` where its grant asks a person. */
  readonly abilities: readonly string[];
  /** The tools behind it, so a coordinator can be kept off what a teammate covers. */
  readonly tools: readonly string[];
}

/** Lists the tools an agent may use and runs them through policy (hard rule 5). */
export interface ToolExecutor {
  /**
   * What each of these agents may use, by area (ADR-0044), from the same
   * grants and connected apps that decide their tool lists. Platform tools
   * every agent has (plan, memory, handoffs) are left out.
   */
  capabilities?(
    ctx: RunContext,
    agentIds: readonly AgentId[],
  ): Promise<ReadonlyMap<string, readonly AgentCapability[]>>;
  /**
   * The tools the model sees. Apps with many tools stay behind `load_toolkit`
   * until the run loads them: `toolkits` holds whole apps by slug (`notes`)
   * and single tools picked from a large app (`notion.create_pages`).
   */
  listTools(
    ctx: RunContext,
    options?: {
      readonly toolkits?: readonly string[];
      /** Only tools that change nothing: a proactive check (M5.10). */
      readonly readOnly?: boolean;
    },
  ): Promise<ToolDescriptor[]>;
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
