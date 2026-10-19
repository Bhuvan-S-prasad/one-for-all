import { INNGEST_EVENTS, type DelegationStatus, type RunStopReason } from "@ofa/contracts";
import {
  APPROVAL_TIMEOUT_MS,
  givenKeys,
  toolkitToolName,
  urlKey,
  urlsIn,
  type AgentDirectory,
  type AgentProfile,
  type ApprovalStore,
  type ChatLedgerEntry,
  type ChatRecord,
  type ChatRecordStore,
  type ChildRunResult,
  type LLMGateway,
  type LLMRequest,
  type MemoryStore,
  type LLMImage,
  rankByRequest,
  ROSTER_HEADING,
  rosterText,
  type RunContext,
  type RunEventWrite,
  type RunStore,
  type RunUsageTotals,
  skillReferences,
  type SkillLibrary,
  type StepRunner,
  type TeamDirectory,
  type ThreadId,
  type ThreadStore,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolOutcome,
  type Verdict,
} from "@ofa/core";
import {
  addToLedger,
  carriedPlan,
  handoffEntry,
  ledgerEntry,
  progressLine,
  quotesOutside,
  stopReply,
} from "./chat-record";
import { compactTurns } from "./compaction";
import {
  assembleContext,
  contextBudget,
  type HistoryMessage,
  type ToolCallTurn,
  type Turn,
} from "./context";
import { modelCallEvents, runEvent } from "./events";
import { MiddlewareChain, type HarnessMiddleware, type RunHookContext } from "./middleware";
import {
  AGENT_MESSAGE,
  FINAL_ANSWER,
  HANDOFF_BRIEF,
  NOTHING_TO_REPORT,
  PROACTIVE_CHECK,
  promptRef,
  ROUTINE_RUN,
  SCHEDULED_TASK,
} from "./prompts";
import { redactJson, type RedactText } from "./redaction";

// The agent loop (ARCHITECTURE.md §6.2). Every side effect happens inside a
// durable step (hard rule 6): model calls, tool calls, run-log writes and the
// reply. Loop state is rebuilt only from step results, so when Inngest
// replays the function after a crash or a wait, the loop takes the same path
// and memoized steps return without running again.

export interface HarnessOptions {
  /** Cap on the prompt size, whatever the model's window (§7). Default 32,000. */
  readonly maxContextTokens?: number;
  /** Thread messages loaded as history. Default 30. */
  readonly historyMessages?: number;
  /** Facts preloaded from memory. Default 8. */
  readonly memoryRecallLimit?: number;
  /** Learn facts worth keeping after each answered run (see `learnFromRun`). Default true. */
  readonly extractMemories?: boolean;
  /** Same tool with the same arguments this many times ends the run. Default 3. */
  readonly loopRepeatLimit?: number;
  /** How long a run waits for a person to answer an approval. Default 24 hours. */
  readonly approvalTimeoutMs?: number;
  /**
   * How long a run waits for work it handed to another agent. Default 25
   * hours: the child may itself wait a day for a person's approval.
   */
  readonly delegationTimeoutMs?: number;
}

export interface HarnessDeps {
  readonly llm: LLMGateway;
  readonly tools: ToolExecutor;
  readonly runs: RunStore;
  readonly agents: AgentDirectory;
  readonly threads: ThreadStore;
  readonly memory?: MemoryStore;
  /**
   * Where approval requests are kept. Without it, or a step runner that can
   * wait, calls that need a person are refused.
   */
  readonly approvals?: ApprovalStore;
  /**
   * The agents a run can hand work to (M5.01). Without it, or a step runner
   * that can start child runs, `delegate_task` is refused.
   */
  readonly team?: TeamDirectory;
  /** Skills the agent may use (M5.08): `/slug` in the request applies one. */
  readonly skills?: SkillLibrary;
  /**
   * Each agent's working record per chat (ADR-0045): read at the start, saved
   * as the run goes, so the next run in the chat carries on from it.
   */
  readonly chats?: ChatRecordStore;
  /**
   * Replaces known secret values (the vault's redaction). Applied to every
   * run event, approval request and reply before it is stored (hard rule 4).
   */
  readonly redact?: RedactText;
  readonly middleware?: readonly HarnessMiddleware[];
  readonly options?: HarnessOptions;
}

export interface RunInput {
  readonly ctx: RunContext;
  readonly threadId: ThreadId | null;
  readonly trigger: "message" | "routine" | "delegation" | "event" | "manual" | "schedule";
  /**
   * The message that started the run. For a run woken by another agent's
   * message (`event`, M5.03), that message is its request; so is a
   * routine's or a scheduled task's request note (M5.06–07).
   */
  readonly requestId?: string;
}

export interface RunResult {
  readonly status: "succeeded" | "failed" | "cancelled" | "skipped";
  readonly stopReason: RunStopReason | null;
  readonly usage: RunUsageTotals;
  readonly messageId: string | null;
  /** The reply it posted; a delegating run reads it as the result (M5.01). */
  readonly reply: string | null;
  /** It read outside content, so the reply may carry someone else's words. */
  readonly tainted: boolean;
  /**
   * Worth a learning pass. Memory extraction runs after the run, in its own
   * function, so the agent is free for the next message as soon as it replies.
   */
  readonly learn: boolean;
}

const EMPTY_USAGE: RunUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  modelCalls: 0,
  toolCalls: 0,
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** Runs on the clock, whose request is a note in the thread (M5.06–07). */
const SCHEDULED = new Set<RunInput["trigger"]>(["routine", "manual", "schedule"]);

/** Handing work to another agent (M5.01); the harness runs the handoff itself. */
const DELEGATE_TASK = "delegate_task";
const DELEGATION_TIMEOUT_MS = 25 * 60 * 60_000;
/** Of a child's reply, what the delegating model reads. */
const DELEGATION_ANSWER_CHARS = 8_000;

/** How a child run ended, in the words the delegating model is told. */
function delegationStatus(child: ChildRunResult | null): DelegationStatus {
  if (!child || child.status === "failed") return "failed";
  if (child.status === "cancelled" || child.status === "skipped") return "cancelled";
  return child.stopReason === "final_answer" ? "done" : "stopped";
}

const DELEGATION_NOTES: Record<DelegationStatus, string> = {
  done: "",
  stopped: "It stopped before finishing; the answer is what it had.",
  failed:
    "Its run failed, so nothing came back. Tell the person, or do the work yourself if you can.",
  cancelled: "Its run was stopped, so nothing came back.",
};

function addUsage(
  usage: RunUsageTotals,
  delta: { inputTokens: number; outputTokens: number; costUsd: number },
  calls: { model?: number; tool?: number } = {},
): RunUsageTotals {
  return {
    inputTokens: usage.inputTokens + delta.inputTokens,
    outputTokens: usage.outputTokens + delta.outputTokens,
    costUsd: usage.costUsd + delta.costUsd,
    modelCalls: usage.modelCalls + (calls.model ?? 0),
    toolCalls: usage.toolCalls + (calls.tool ?? 0),
  };
}

function preview(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A coordinator's team (ADR-0044): its roster, and which teammates have each tool. */
interface CoordinatorTeam {
  readonly roster: string;
  /** Tool name → handles of the teammates that have it. */
  readonly covered: Record<string, string[]>;
  /** It leads a group chat, where it routes messages with `message_agent` (ADR-0033). */
  readonly group: boolean;
}

/** Messages wake an agent that answers later (M5.03). */
const MESSAGE_AGENT = "message_agent";

/**
 * A coordinator's tool list (ADR-0044): without the tools a teammate has, and
 * with the roster moved out of `delegate_task` into its instructions.
 */
function forCoordinator(tools: readonly ToolDescriptor[], team: CoordinatorTeam): ToolDescriptor[] {
  return (
    tools
      .filter((t) => !team.covered[t.name])
      // Outside a group, a message answers later, after the coordinator has
      // replied: it handed work on with it and ended its turn "waiting" (TC.09).
      .filter((t) => team.group || t.name !== MESSAGE_AGENT)
      .map((t) =>
        t.name === DELEGATE_TASK
          ? {
              ...t,
              description: `${t.description.split(`\n${ROSTER_HEADING}`)[0]}\nYour team, with what each one can do, is in your instructions.`,
            }
          : t,
      )
  );
}

/** The search a `web.search` call asked for, written the same way each time. */
function searchKey(args: unknown): string | null {
  const query = (args as { query?: unknown } | null)?.query;
  if (typeof query !== "string") return null;
  const key = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$]+/gu, " ")
    .trim();
  return key || null;
}

/** A tool call written out as text: not an answer. */
const TOOL_MARKUP = /<\/?(?:\w+_)?function_call|<invoke\b|<parameter\b|<tool_call\b/i;

/** From here a run is told to finish (ADR-0045): this share of its token or step budget. */
const WRAP_UP_AT = 0.8;

const STOP_NOTES: Partial<Record<RunStopReason, string>> = {
  step_budget: "I stopped before finishing: I reached my step limit for one task.",
  token_budget: "I stopped before finishing: I reached my token budget for one task.",
  cost_budget: "I stopped before finishing: I reached my cost budget for one task.",
  loop_detected: "I stopped: I was repeating the same step without making progress.",
};

/** What the model step returns. Plain JSON, so the step runner can store it. */
interface ModelStepResult {
  readonly text: string;
  readonly toolCalls: readonly (ToolCallTurn & { readonly invalid?: string })[];
  readonly usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

interface ToolStepResult {
  readonly content: string;
  readonly untrusted: boolean;
  readonly ok: boolean;
  readonly taintedNow: boolean;
  /** A screenshot to show the model with the result (DT.11). */
  readonly image?: LLMImage;
  /** Policy wants a person to agree first; nothing ran yet. */
  readonly approval?: {
    readonly verdict: Verdict;
    readonly reasons: readonly string[];
    readonly summary: string;
    /** The site the person may allow for the rest of the run instead. */
    readonly site?: string;
    readonly editable?: readonly string[];
    readonly showArgs?: boolean;
  };
}

/**
 * A person's answer: for this call only, or for every call like it on a site
 * (M4.07), and the text they changed before approving (ADR-0030).
 */
interface Decision {
  readonly status: "approved" | "rejected" | "expired";
  readonly site: string | null;
  readonly edits: Record<string, string> | null;
}

/** What the model is told when a person changed the call before it ran. */
function editedNote(fields: readonly string[]): string {
  const names =
    fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}` : fields[0];
  return `The person changed ${names} before approving, so this ran with their version.`;
}

/**
 * A call to a tool the model wasn't given, while apps wait behind
 * `load_toolkit`, gets told how to load it: with "Unknown tool" alone, an
 * agent guessed Notion tool names for six steps (M4 end-to-end check).
 */
function withLoadHint<T extends { readonly name: string; readonly invalid?: string }>(
  call: T,
  tools: readonly ToolDescriptor[],
): T {
  if (!call.invalid || tools.some((t) => t.name === call.name)) return call;
  if (!tools.some((t) => t.name === "load_toolkit")) return call;
  return {
    ...call,
    invalid: `${call.invalid}. If it belongs to a connected app, call load_toolkit first with the app and the tools you need, then call them by the names it gives.`,
  };
}

/**
 * The first wait for an answer is short, then the row is checked: a decision
 * made before the wait started (which the wait cannot see) is picked up there.
 */
const FIRST_WAIT_MS = 60_000;

const DECLINED: Record<"rejected" | "expired", string> = {
  rejected:
    "Not done: the person said no to this. Do not try it another way; tell them what you would have done, or ask what they want instead.",
  expired:
    "Not done: nobody answered the approval request in time. Tell the person what is still waiting for them.",
};

export async function runAgent(
  input: RunInput,
  deps: HarnessDeps,
  steps: StepRunner,
): Promise<RunResult> {
  const { ctx } = input;
  const options = deps.options ?? {};
  const chain = new MiddlewareChain(deps.middleware ?? []);
  const redact: RedactText = deps.redact ?? (async (_ctx, text) => text);
  const log = async (events: RunEventWrite[]) =>
    deps.runs.append(ctx, ctx.runId, await redactJson(redact, ctx, events));
  let hook: RunHookContext | null = null;
  /** Addresses the run was given, in `urlKey` form (filled in as the run goes). */
  const knownUrls = new Set<string>();
  /** Addresses the agent wrote into its own calls before they were given: never given later. */
  const authoredUrls = new Set<string>();
  /**
   * What each handoff in this run answered, by handle and name, so a later
   * brief can carry it in full (`include_results_from`, TC.09). Rebuilt on
   * replay from the memoized handoff steps.
   */
  const handoffAnswers = new Map<string, string[]>();
  /** Sites a person allowed for the rest of this run, rebuilt on replay from memoized answers. */
  const allowedSites = new Set<string>();
  /** A proactive check (M5.10): only tools that change nothing, listed and run. */
  let proactive = false;

  try {
    // ── Start ────────────────────────────────────────────────────────────────
    const start = await steps.run("start", async () => {
      const run = await deps.runs.get(ctx, ctx.runId);
      if (!run) throw new Error(`Run ${ctx.runId} not found`);
      if (TERMINAL.has(run.status)) return { skip: true as const };
      const agent = await deps.agents.get(ctx, ctx.agentId);
      if (!agent) throw new Error(`Agent ${ctx.agentId} not found`);
      await chain.runStart({ ctx, agent });
      await deps.runs.update(ctx, ctx.runId, {
        status: "running",
        startedAt: new Date(),
        onlyIfActive: true,
      });
      // Another run may have taken this one's message as steering (M5.05)
      // between the read above and the update: then it is already answered.
      const now = await deps.runs.get(ctx, ctx.runId);
      if (now && TERMINAL.has(now.status)) return { skip: true as const };
      await log([
        runEvent("start", "run.started", { trigger: input.trigger, tier: agent.modelTier }),
      ]);
      return {
        skip: false as const,
        agent,
        tainted: run.tainted,
        proactive: run.proactive ?? false,
        request: run.request ?? null,
        today: new Date().toISOString().slice(0, 10),
      };
    });
    if (start.skip) {
      return {
        status: "skipped",
        stopReason: null,
        usage: EMPTY_USAGE,
        messageId: null,
        reply: null,
        tainted: false,
        learn: false,
      };
    }
    const agent: AgentProfile = start.agent;
    hook = { ctx, agent };
    proactive = start.proactive;
    let tainted = start.tainted;
    // A handoff's thread is new each time, so only other runs keep a record (ADR-0045).
    const keepsRecord = !!deps.chats && !!input.threadId && input.trigger !== "delegation";

    if (agent.status !== "active") {
      return await finish({
        status: "failed",
        stopReason: "error",
        usage: EMPTY_USAGE,
        error: { code: "agent_inactive", message: `${agent.name} is ${agent.status}` },
        messageId: null,
        reply: null,
        tainted,
      });
    }

    // ── Context that holds for the whole run ─────────────────────────────────
    const context = await steps.run("context", async () => {
      const messages = input.threadId
        ? await deps.threads.recentMessages(ctx, input.threadId, options.historyMessages ?? 30)
        : [];
      // Other agents in the thread, by name (M5.03–04): who said what.
      const names = new Map<string, string>();
      for (const id of new Set(messages.flatMap((m) => (m.agentId ? [m.agentId] : [])))) {
        if (id === ctx.agentId) continue;
        const other = await deps.agents.get(ctx, id as AgentProfile["id"]);
        names.set(id, other?.name ?? "Another agent");
      }
      const history: HistoryMessage[] = messages.map((m) => {
        const fromOther = m.author === "agent" && m.agentId !== null && m.agentId !== ctx.agentId;
        // Work handed over by another agent (M5.01) is this run's request.
        if (fromOther && input.trigger === "delegation") {
          return {
            author: "user",
            agentId: null,
            content: HANDOFF_BRIEF.render({ brief: m.content }),
            handoff: true,
          };
        }
        // A routine's or a scheduled task's note is the request of its run
        // (M5.06–07); other notes are for people only.
        if (m.author === "system" && m.id === input.requestId && SCHEDULED.has(input.trigger)) {
          return {
            author: "user",
            agentId: null,
            content: (input.trigger === "schedule" ? SCHEDULED_TASK : ROUTINE_RUN).render({
              request: m.content,
            }),
            scheduled: input.trigger === "schedule" ? "task" : "routine",
          };
        }
        // So is the message from another agent that woke this run (M5.03).
        if (fromOther && input.trigger === "event" && m.id === input.requestId) {
          return {
            author: "user",
            agentId: null,
            content: AGENT_MESSAGE.render({ from: names.get(m.agentId!)!, message: m.content }),
            agentMessage: true,
          };
        }
        return {
          author: m.author,
          agentId: m.agentId,
          content: m.content,
          ...(fromOther ? { agentName: names.get(m.agentId!)! } : {}),
        };
      });
      const lastUser = [...history].reverse().find((m) => m.author === "user")?.content ?? "";
      // The request as written, for the episode and for `/skill` references.
      const asked =
        (input.requestId ? messages.find((m) => m.id === input.requestId) : undefined) ??
        [...messages].reverse().find((m) => m.author === "user");
      const request = asked?.content ?? "";
      let skill: { name: string; slug: string; steps: string[] } | null = null;
      if (deps.skills && request) {
        for (const ref of skillReferences(request)) {
          const found = await deps.skills.find(ctx, ref);
          if (found) {
            skill = { name: found.name, slug: found.slug, steps: [...found.steps] };
            break;
          }
        }
      }
      // Earlier work like this one (M5.09), as plain lines: step results are JSON.
      const episodes =
        deps.memory?.recallEpisodes && lastUser && agent.memoryScopes.length > 0
          ? (await deps.memory.recallEpisodes(ctx, { query: lastUser, limit: 2 })).map(
              (e) =>
                `${new Date(e.createdAt).toISOString().slice(0, 10)}: ${e.summary}${e.outcome === "done" ? "" : ` (${e.outcome})`}`,
            )
          : [];
      const memories =
        deps.memory && lastUser && agent.memoryScopes.length > 0
          ? (
              await deps.memory.recall(ctx, {
                query: lastUser,
                scopes: agent.memoryScopes,
                limit: options.memoryRecallLimit ?? 8,
              })
            ).map((m) => m.content)
          : [];
      // A check's request travels on the run, not in the chat (M5.10).
      if (start.request && !messages.some((m) => m.id === input.requestId)) {
        history.push({
          author: "user",
          agentId: null,
          content: PROACTIVE_CHECK.render({ request: start.request }),
          scheduled: "check",
        });
      }
      const tools: ToolDescriptor[] = await deps.tools.listTools(
        ctx,
        start.proactive ? { readOnly: true } : undefined,
      );
      const model = await deps.llm.modelFor(agent.modelTier, ctx);
      // What this agent already did in this chat (ADR-0045). A record that
      // quotes outside content (a tainted child's answer) taints this run too.
      const record: ChatRecord | null = keepsRecord
        ? await deps.chats!.get(ctx, input.threadId as ThreadId)
        : null;
      // A coordinator (ADR-0044): by its role, or as the leader of this group
      // chat. A run handed work or woken by another agent has no team (one
      // level, one hop), so it works as itself.
      let team: CoordinatorTeam | null = null;
      if (deps.team && !start.proactive && input.trigger !== "delegation") {
        const leadsGroup =
          !!input.threadId &&
          !!deps.threads.coordinatorOf &&
          (await deps.threads.coordinatorOf(ctx, input.threadId)) === ctx.agentId;
        const leads = agent.role === "coordinator" || leadsGroup;
        const members = leads ? await deps.team.members(ctx) : [];
        if (members.length > 0) {
          const covered: Record<string, string[]> = {};
          for (const member of members) {
            for (const card of member.capabilities ?? []) {
              for (const tool of card.tools) (covered[tool] ??= []).push(member.slug);
            }
          }
          team = {
            roster: rosterText(rankByRequest(members, request)),
            covered,
            group: leadsGroup,
          };
        }
      }
      const taintedByRecord = !start.tainted && quotesOutside(record);
      if (taintedByRecord) {
        await log([
          runEvent("context-taint", "run.tainted", { source: "earlier work in this chat" }),
        ]);
        await deps.runs.update(ctx, ctx.runId, { tainted: true });
      }
      return {
        history,
        memories,
        tools: team ? forCoordinator(tools, team) : tools,
        window: model.contextWindow,
        messageIds: messages.map((m) => m.id as string),
        request: request.slice(0, 600),
        skill,
        episodes,
        record,
        taintedByRecord,
        team,
      };
    });
    if (context.taintedByRecord) tainted = true;
    // Answers from handoffs earlier in this chat (shortened in the record), so
    // a run that continues can still pass them on (TC.10).
    for (const entry of context.record?.ledger ?? []) {
      if (entry.kind !== "handoff" || !entry.agent || !entry.answer) continue;
      const kept = `(From earlier in this chat, shortened.) ${entry.answer}`;
      handoffAnswers.set(entry.agent, [...(handoffAnswers.get(entry.agent) ?? []), kept]);
    }
    const budget = contextBudget(context.window, options.maxContextTokens ?? 32_000);

    // Addresses the run was given (§10.3): in the conversation, and in what
    // its tools return. In a tainted run, opening any other one needs a person.
    const learnUrls = (text: string) => {
      for (const url of urlsIn(text)) {
        if (authoredUrls.has(urlKey(url))) continue;
        for (const k of givenKeys(url)) knownUrls.add(k);
      }
    };
    for (const message of context.history) {
      // A brief or message was written by another model. If that run had read
      // outside content (so this one starts tainted), addresses in it were
      // not given by a person and must not open freely here (ADR-0027).
      if ((message.handoff || message.agentMessage || message.scheduled) && start.tainted) continue;
      learnUrls(message.content);
    }
    // So were the record's, unless a run that wrote it had read outside content.
    if (context.record && !context.record.tainted) {
      for (const entry of context.record.ledger) learnUrls(entry.text);
    }

    // ── The loop ─────────────────────────────────────────────────────────────
    let usage = EMPTY_USAGE;
    let turns: Turn[] = [];
    let summary: string | null = null;
    // A plan the last run in this chat left open carries on here (ADR-0045).
    let todos: { text: string; done: boolean }[] | null = carriedPlan(context.record);
    const planCarried = todos !== null;
    const seen = new Map<string, number>();
    let finalText: string | null = null;
    let stopReason: RunStopReason = "step_budget";
    // Apps behind load_toolkit join the tool list once loaded (M4.05); both
    // rebuild on replay from the memoized tool steps.
    let tools = context.tools;
    const loadedToolkits = new Set<string>();
    // The chat record (ADR-0045): built only from step results, so a replay
    // rebuilds it the same way. `thisRun` is what this run added.
    let ledger: ChatLedgerEntry[] = [...(context.record?.ledger ?? [])];
    const thisRun: ChatLedgerEntry[] = [];
    let recordChanged = false;
    const record = (ended: RunStopReason | null): ChatRecord => ({
      plan: todos ?? context.record?.plan ?? null,
      ledger,
      notes: summary ?? context.record?.notes ?? null,
      stopReason: ended,
      runId: ctx.runId,
      tainted: tainted || (context.record?.tainted ?? false),
    });
    const keep = (entries: readonly (ChatLedgerEntry | null)[]) => {
      const kept = entries.filter((e): e is ChatLedgerEntry => e !== null);
      if (kept.length === 0) return;
      ledger = addToLedger(ledger, kept);
      thisRun.push(...kept);
      recordChanged = true;
    };
    const saveRecord = async (id: string, ended: RunStopReason | null) => {
      if (!keepsRecord) return;
      const now = record(ended);
      // Nothing worth carrying, and nothing to replace.
      if (!context.record && !now.plan && now.ledger.length === 0 && !now.notes) return;
      await steps.run(id, async () => {
        const redacted = await redactJson(redact, ctx, now);
        await deps.chats!.save(ctx, input.threadId as ThreadId, redacted as ChatRecord);
        return true;
      });
    };
    // Searches this run made, so the same one again reuses its result (ADR-0045).
    const searches = new Map<string, { toolCallId: string; content: string; untrusted: boolean }>();

    for (let i = 0; i < agent.budgets.steps; i += 1) {
      // Most of the budget spent: the task block says to finish (ADR-0045).
      const wrapUp =
        usage.inputTokens + usage.outputTokens >= agent.budgets.tokens * WRAP_UP_AT ||
        (i + 1) / agent.budgets.steps >= WRAP_UP_AT;
      // Steering (§6.3, M5.05): what the person wrote here while the run
      // worked joins it at this step boundary, instead of waiting its turn.
      if (input.threadId && deps.runs.claimFollowUps) {
        const followUps = await steps.run(`steer-${i}`, async () => {
          const claimed = await deps.runs.claimFollowUps!(ctx, input.threadId as ThreadId);
          if (claimed.length === 0) return [];
          await log([
            runEvent(`steer-${i}`, "run.steered", {
              messageIds: claimed.map((m) => m.id),
              preview: preview(claimed.map((m) => m.content).join(" · "), 280),
            }),
          ]);
          // Ones already in the history (written before it was read) are answered there.
          return claimed
            .filter((m) => !context.messageIds.includes(m.id))
            .map((m) => ({ id: m.id as string, content: m.content }));
        });
        for (const message of followUps) {
          turns.push({ kind: "user", text: message.content });
          learnUrls(message.content);
        }
      }

      let assembled = assembleContext(
        {
          today: start.today,
          agent,
          tools,
          memories: context.memories,
          episodes: context.episodes,
          skill: context.skill,
          todos,
          history: context.history,
          summary,
          turns,
          record: context.record,
          team: context.team?.roster ?? null,
          planCarried,
          wrapUp,
        },
        budget,
      );

      if (assembled.needsCompaction) {
        const compacted = await steps.run(`compact-${i}`, async () => {
          const result = await compactTurns(deps.llm, ctx, summary, turns);
          if (result) {
            const after = assembleContext(
              {
                today: start.today,
                agent,
                tools,
                memories: context.memories,
                episodes: context.episodes,
                skill: context.skill,
                todos,
                history: context.history,
                summary: result.summary,
                turns: turns.slice(result.replaced),
                record: context.record,
                team: context.team?.roster ?? null,
                planCarried,
                wrapUp,
              },
              budget,
            );
            await log([
              ...modelCallEvents(
                `compact-${i}-model`,
                "fast",
                result.response,
                result.promptVersion,
              ),
              // An empty summary replaced nothing, so there is nothing to report.
              ...(result.replaced > 0
                ? [
                    runEvent(`compact-${i}`, "run.compacted", {
                      tokensBefore: assembled.tokens.total,
                      tokensAfter: after.tokens.total,
                    }),
                  ]
                : []),
            ]);
          }
          return result;
        });
        if (compacted) {
          summary = compacted.summary;
          recordChanged = true;
          // The summary is the model's own text: every address it should
          // carry was learned when it first appeared (ADR-0027).
          if (!tainted) learnUrls(compacted.summary);
          turns = turns.slice(compacted.replaced);
          usage = addUsage(usage, compacted, { model: 1 });
          assembled = assembleContext(
            {
              today: start.today,
              agent,
              tools,
              memories: context.memories,
              episodes: context.episodes,
              skill: context.skill,
              todos,
              history: context.history,
              summary,
              turns,
              record: context.record,
              team: context.team?.roster ?? null,
              planCarried,
              wrapUp,
            },
            budget,
          );
        }
      }

      const request: LLMRequest = {
        tier: agent.modelTier,
        messages: assembled.messages,
        tools: assembled.tools,
        maxOutputTokens: assembled.maxOutputTokens,
        temperature: 0.3,
        promptVersion: assembled.promptVersion,
      };
      const step: ModelStepResult = await steps.run(`model-${i}`, async () => {
        const call = chain.model(hook as RunHookContext, (r) => deps.llm.generate(r, ctx));
        try {
          const response = await call(request);
          await log(
            modelCallEvents(`model-${i}`, agent.modelTier, response, request.promptVersion),
          );
          // Back from waiting for capacity, if the previous attempt had to wait.
          await deps.runs.update(ctx, ctx.runId, { status: "running", onlyIfStatus: "waiting" });
          return {
            text: response.text,
            toolCalls: response.toolCalls.map((c) => ({
              id: c.id,
              name: c.name,
              args: c.args ?? {},
              ...(c.invalid ? { invalid: c.invalid } : {}),
            })),
            usage: response.usage,
          };
        } catch (error) {
          const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
          if (retryAfterMs !== undefined) {
            // The step will be retried after the wait; show why it paused.
            await log([
              runEvent(`model-${i}-waiting`, "run.waiting", {
                reason: "model_capacity",
                until: new Date(Date.now() + retryAfterMs).toISOString(),
              }),
            ]);
            await deps.runs.update(ctx, ctx.runId, { status: "waiting", onlyIfActive: true });
          }
          throw error;
        }
      });
      usage = addUsage(usage, step.usage, { model: 1 });

      if (step.toolCalls.length === 0) {
        finalText = step.text.trim();
        stopReason = "final_answer";
        break;
      }
      if (usage.inputTokens + usage.outputTokens > agent.budgets.tokens) {
        stopReason = "token_budget";
        break;
      }
      if (agent.budgets.costUsd !== undefined && usage.costUsd > agent.budgets.costUsd) {
        stopReason = "cost_budget";
        break;
      }

      // Loop detection: the same call again and again is not progress.
      const repeated = step.toolCalls.some((c) => {
        const signature = `${c.name}:${JSON.stringify(c.args)}`;
        const count = (seen.get(signature) ?? 0) + 1;
        seen.set(signature, count);
        return count >= (options.loopRepeatLimit ?? 3);
      });
      if (repeated) {
        stopReason = "loop_detected";
        break;
      }

      turns.push({
        kind: "assistant",
        text: step.text,
        toolCalls: step.toolCalls.map(({ id, name, args }) => ({ id, name, args })),
      });

      // Handoffs this step asked for, run together once its calls are checked (M5.02).
      const handoffs: { toolCallId: string; turn: number; args: unknown }[] = [];
      for (const [j, offered] of step.toolCalls.entries()) {
        const toolCallId = `tool-${i}-${j}`;
        const call = withLoadHint(offered, tools);
        /** The call as it ran: with the person's changes, if they made any. */
        let ran: ToolCallTurn = call;
        // An address the agent writes into a call before it was given is its
        // own (ADR-0027): reading it back later (from a file it wrote) must
        // not make it given.
        for (const url of urlsIn(JSON.stringify(call.args ?? {}))) {
          const k = urlKey(url);
          if (!knownUrls.has(k)) authoredUrls.add(k);
        }
        // The same search again in this run gets its earlier result (ADR-0045):
        // nothing runs, so there is no new call to check or count.
        const key = call.name === "web.search" && !call.invalid ? searchKey(call.args) : null;
        const earlier = key ? searches.get(key) : undefined;
        // A coordinator's teammate has this tool (ADR-0044): it isn't in its
        // list, and if it calls it anyway, nothing runs.
        const owners = context.team?.covered[call.name];
        let result: ToolStepResult = owners
          ? await steps.run(`${toolCallId}-team`, async () => {
              await log([
                runEvent(`${toolCallId}-failed`, "tool.failed", {
                  toolCallId,
                  tool: call.name.slice(0, 100),
                  durationMs: 0,
                  code: "left_to_team",
                  message: `Left to ${owners.join(", ")}`,
                }),
              ]);
              return {
                content: `Not done: ${call.name} is your team's work. Hand it to ${owners.join(" or ")} with delegate_task.`,
                untrusted: false,
                ok: false,
                taintedNow: false,
              };
            })
          : earlier
            ? await steps.run(`${toolCallId}-reused`, async () => {
                await log([
                  runEvent(`${toolCallId}-reused`, "tool.reused", {
                    toolCallId,
                    tool: call.name,
                    reusedFrom: earlier.toolCallId,
                  }),
                ]);
                return {
                  content: `You already ran this search in this task, so here are the same results again. Use them, or search for something different.\n${earlier.content}`,
                  untrusted: earlier.untrusted,
                  ok: true,
                  taintedNow: false,
                };
              })
            : await steps.run(toolCallId, () => runTool(toolCallId, call, tainted));
        if (result.approval) {
          const decision = await askPerson(toolCallId, call, result.approval);
          if (decision.status === "approved" && decision.site) allowedSites.add(decision.site);
          if (decision.status === "approved") {
            const { edits } = decision;
            // Their version runs, checked against the tool's schema again.
            const asApproved = edits
              ? { ...call, args: { ...(call.args as Record<string, unknown>), ...edits } }
              : call;
            ran = asApproved;
            result = await steps.run(`${toolCallId}-approved`, () =>
              runTool(toolCallId, asApproved, tainted, true),
            );
            if (edits) {
              result = {
                ...result,
                content: `${editedNote(Object.keys(edits))}
${result.content}`,
              };
            }
          } else {
            result = {
              content: DECLINED[decision.status],
              untrusted: false,
              ok: false,
              taintedNow: false,
            };
          }
        }
        if (!earlier && !owners) {
          usage = addUsage(usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 }, { tool: 1 });
        }
        if (result.taintedNow) tainted = true;
        if (result.ok && call.name === "todo.write") {
          const items = (call.args as { items?: { text: string; done: boolean }[] }).items;
          if (Array.isArray(items)) {
            todos = items;
            recordChanged = true;
          }
        }
        if (key && result.ok && !earlier) {
          searches.set(key, { toolCallId, content: result.content, untrusted: result.untrusted });
        }
        // What it did, for the chat record; a handoff is kept when its answer is in.
        if (!earlier && ran.name !== DELEGATE_TASK) {
          keep([
            ledgerEntry(
              ran,
              result,
              tools.find((t) => t.name === ran.name),
              ctx.runId,
            ),
          ]);
        }
        if (result.ok && call.name === "load_toolkit") {
          const args = call.args as { app?: unknown; tools?: unknown };
          const app = String(args.app ?? "")
            .trim()
            .toLowerCase();
          // A whole app, or the tools picked from a large one.
          const picked = Array.isArray(args.tools)
            ? args.tools.map((t) => toolkitToolName(app, String(t)))
            : [app];
          const fresh = app ? picked.filter((entry) => !loadedToolkits.has(entry)) : [];
          if (fresh.length) {
            for (const entry of fresh) loadedToolkits.add(entry);
            tools = await steps.run(`${toolCallId}-toolkit`, () =>
              deps.tools.listTools(ctx, {
                toolkits: [...loadedToolkits],
                ...(proactive ? { readOnly: true } : {}),
              }),
            );
            if (context.team) tools = forCoordinator(tools, context.team);
          }
        }
        if (result.ok && call.name === DELEGATE_TASK) {
          handoffs.push({ toolCallId, turn: turns.length, args: ran.args });
        }
        if (result.image) {
          // Only the latest screenshot stays (DT.11): older ones leave the
          // prompt and the run's state.
          for (const [n, turn] of turns.entries()) {
            if (turn.kind === "tool" && turn.image) {
              const { image: _dropped, ...rest } = turn;
              turns[n] = rest;
            }
          }
        }
        turns.push({
          kind: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          untrusted: result.untrusted,
          ...(result.image ? { image: result.image } : {}),
        });
        learnUrls(result.content);
      }

      // Fork-join (§6.3): every handoff from this step runs at once, and the
      // run carries on when all of them have come back.
      if (handoffs.length > 0) {
        const taintedBefore = tainted;
        const results = await Promise.all(
          handoffs.map((h) => delegate(h.toolCallId, h.args, taintedBefore)),
        );
        for (const [n, h] of handoffs.entries()) {
          const done = results[n]!;
          const turn = turns[h.turn];
          if (turn?.kind === "tool") {
            turns[h.turn] = { ...turn, content: done.content, untrusted: done.untrusted };
          }
          if (done.untrusted) tainted = true;
          learnUrls(done.content);
          keep([handoffEntry(h.args, done, ctx.runId)]);
          rememberAnswer(h.args, done.content);
        }
      }

      // Saved as the run goes (ADR-0045), so a run that fails or is stopped
      // still leaves what it did for the next one.
      if (recordChanged) {
        await saveRecord(`record-${i}`, null);
        recordChanged = false;
      }
    }
    await saveRecord("record-end", stopReason);

    // A run out of budget still answers with what it has (ADR-0045, TC.09):
    // one last call, without tools. A handoff's answer then carries findings
    // back instead of only "I stopped". A failed call just leaves the note.
    let partial: string | null = null;
    if ((stopReason === "token_budget" || stopReason === "step_budget") && !proactive) {
      const last = await steps.run("wrap-up", async () => {
        const assembled = assembleContext(
          {
            today: start.today,
            agent,
            tools: [],
            memories: context.memories,
            episodes: context.episodes,
            skill: context.skill,
            todos,
            history: context.history,
            summary,
            turns,
            record: context.record,
            planCarried,
            team: context.team?.roster ?? null,
            wrapUp: true,
          },
          budget,
        );
        const request: LLMRequest = {
          tier: agent.modelTier,
          messages: [...assembled.messages, { role: "user", content: FINAL_ANSWER.render({}) }],
          tools: [],
          maxOutputTokens: assembled.maxOutputTokens,
          temperature: 0.3,
          promptVersion: `${assembled.promptVersion}+${promptRef(FINAL_ANSWER)}`,
        };
        try {
          const call = chain.model(hook as RunHookContext, (r) => deps.llm.generate(r, ctx));
          const response = await call(request);
          await log(modelCallEvents("wrap-up", agent.modelTier, response, request.promptVersion));
          return { text: response.text.trim(), usage: response.usage };
        } catch {
          return null;
        }
      });
      if (last) {
        usage = addUsage(usage, last.usage, { model: 1 });
        // A small model may write a tool call as text even with none offered.
        partial = last.text && !TOOL_MARKUP.test(last.text) ? last.text : null;
      }
    }

    // ── Reply ────────────────────────────────────────────────────────────────
    // Stopped early: what it had, what is left and how to go on (ADR-0045).
    const plan = todos ?? context.record?.plan ?? null;
    const replyText =
      stopReason === "final_answer"
        ? finalText || "I don't have anything to add."
        : stopReply(
            STOP_NOTES[stopReason] ?? "I stopped before finishing.",
            thisRun,
            plan,
            partial,
          );
    // A check with nothing to report stays quiet (M5.10): no message, so the
    // person hears from it only when something needs them.
    const quiet =
      proactive && stopReason === "final_answer" && NOTHING_TO_REPORT.test(finalText ?? "");
    if (quiet) {
      await steps.run("quiet", async () => {
        await log([runEvent("quiet", "check.quiet", {})]);
        return true;
      });
    }
    const posted =
      input.threadId && !quiet
        ? await steps.run("reply", async () => {
            const content = await redact(ctx, replyText);
            const id = await deps.threads.addAgentMessage(ctx, {
              threadId: input.threadId as ThreadId,
              content,
            });
            await log([
              runEvent("reply", "message.created", {
                messageId: id,
                preview: preview(content, 280),
              }),
            ]);
            // The reply as posted (redacted): a delegating run reads it back
            // from the step's stored result (M5.01).
            return { id: id as string, content };
          })
        : null;

    // A run that posted before this step returned the content kept its ID only.
    const reply = typeof posted === "string" ? { id: posted, content: null } : posted;
    return await finish({
      status: "succeeded",
      stopReason,
      usage,
      messageId: reply?.id ?? null,
      reply: reply?.content ?? null,
      tainted,
      request: context.request,
      progress: stopReason === "final_answer" ? null : progressLine(thisRun, plan),
    });
  } catch (error) {
    await chain.error(hook, error);
    throw error;
  }

  /**
   * Ask a person about one call and wait for the answer (§6.2). The wait
   * holds no process. The approval row is the truth: the API settles it, then
   * sends the event that ends the wait early.
   */
  async function askPerson(
    toolCallId: string,
    call: ToolCallTurn,
    approval: NonNullable<ToolStepResult["approval"]>,
  ): Promise<Decision> {
    const approvals = deps.approvals as ApprovalStore;
    const waitFor = (id: string, timeoutMs: number) =>
      steps.waitForEvent!(id, {
        event: INNGEST_EVENTS.approvalDecided,
        field: "approvalId",
        value: asked.id,
        timeoutMs,
      });
    const timeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;

    const asked = await steps.run(`${toolCallId}-ask`, async () => {
      const args = await redactJson(redact, ctx, call.args);
      // Text that holds a secret is shown redacted, so it can't be edited:
      // saving the card would replace the secret with "[REDACTED]".
      const original = (call.args ?? {}) as Record<string, unknown>;
      const shown = (args ?? {}) as Record<string, unknown>;
      const editable = (approval.editable ?? []).filter(
        (name) => typeof original[name] === "string" && shown[name] === original[name],
      );
      const record = await approvals.request(ctx, {
        toolCallId,
        tool: call.name,
        args,
        summary: await redact(ctx, approval.summary),
        reasons: approval.reasons,
        verdict: approval.verdict,
        site: approval.site ?? null,
        editable,
        showArgs: approval.showArgs ?? false,
        expiresAt: new Date(Date.now() + timeoutMs),
      });
      await log([
        runEvent(`${toolCallId}-ask`, "approval.requested", {
          approvalId: record.id,
          toolCallId,
          tool: call.name,
        }),
        runEvent(`${toolCallId}-waiting`, "run.waiting", {
          reason: "approval",
          until: record.expiresAt.toISOString(),
        }),
      ]);
      await deps.runs.update(ctx, ctx.runId, { status: "waiting", onlyIfActive: true });
      return { id: record.id as string, status: record.status };
    });

    if (asked.status === "pending") {
      const early = await waitFor(`${toolCallId}-wait`, Math.min(FIRST_WAIT_MS, timeoutMs));
      if (!early && timeoutMs > FIRST_WAIT_MS) {
        const now = await steps.run(
          `${toolCallId}-check`,
          async () => (await approvals.get(ctx, asked.id))?.status ?? "expired",
        );
        if (now === "pending") await waitFor(`${toolCallId}-wait-more`, timeoutMs - FIRST_WAIT_MS);
      }
    }

    return steps.run(`${toolCallId}-decided`, async () => {
      let record = await approvals.get(ctx, asked.id);
      if (record?.status === "pending") {
        // No answer in time. If someone answers this very moment, theirs wins.
        record =
          (await approvals.decide(ctx, asked.id, { status: "expired", decidedBy: null })) ??
          (await approvals.get(ctx, asked.id));
      }
      const status: Decision["status"] =
        record && record.status !== "pending" ? record.status : "expired";
      const site = status === "approved" && record?.scope === "site" ? record.site : null;
      // Only text the card offered for editing; the API checks the same.
      const changed = Object.entries(status === "approved" ? (record?.edits ?? {}) : {}).filter(
        ([name, value]) => record?.editable.includes(name) && typeof value === "string",
      );
      const edits = changed.length > 0 ? Object.fromEntries(changed) : null;
      await log([
        runEvent(`${toolCallId}-decided`, "approval.decided", {
          approvalId: asked.id,
          decision: edits ? "edited" : status,
          decidedBy: record?.decidedBy ?? null,
          ...(site ? { allowedSite: site } : {}),
          ...(edits ? { edited: Object.keys(edits) } : {}),
        }),
        runEvent(`${toolCallId}-resumed`, "run.resumed", {}),
      ]);
      await deps.runs.update(ctx, ctx.runId, { status: "running", onlyIfStatus: "waiting" });
      return { status, site, edits } satisfies Decision;
    });
  }

  async function runTool(
    toolCallId: string,
    call: ToolCallTurn & { readonly invalid?: string },
    taintedBefore: boolean,
    approved = false,
  ): Promise<ToolStepResult> {
    if (call.invalid) {
      await log([
        runEvent(`${toolCallId}-failed`, "tool.failed", {
          toolCallId,
          tool: call.name.slice(0, 100),
          durationMs: 0,
          code: "invalid_call",
          message: call.invalid.slice(0, 2_000),
        }),
      ]);
      return { content: `Error: ${call.invalid}`, untrusted: false, ok: false, taintedNow: false };
    }
    const request = {
      name: call.name,
      args: call.args,
      toolCallId,
      idempotencyKey: `${ctx.runId}:${toolCallId}`,
      tainted: taintedBefore,
      knownUrls: [...knownUrls],
      allowedSites: [...allowedSites],
      ...(approved ? { approved: true } : {}),
      ...(proactive ? { readOnly: true } : {}),
    };
    const execute = chain.tool(hook as RunHookContext, (r) => deps.tools.execute(r, ctx));
    let outcome: ToolOutcome;
    try {
      outcome = await execute(request);
    } catch (error) {
      outcome = {
        status: "error",
        code: "tool_crashed",
        // It goes to the model as well as the run log.
        message: await redact(ctx, errorMessage(error)),
        durationMs: 0,
      };
    }

    const events: RunEventWrite[] = [];
    // An approved call's verdict was logged when it was held.
    if (!approved && (outcome.status !== "error" || outcome.verdict)) {
      const verdict = outcome.status === "error" ? outcome.verdict! : outcome.verdict;
      const reasons = outcome.status === "error" ? (outcome.reasons ?? []) : outcome.reasons;
      events.push(
        runEvent(`${toolCallId}-policy`, "policy.decided", {
          toolCallId,
          tool: call.name,
          verdict,
          reasons: [...reasons],
        }),
      );
    }
    if (outcome.status !== "blocked") {
      events.push(
        runEvent(`${toolCallId}-called`, "tool.called", {
          toolCallId,
          tool: call.name,
          args: call.args,
          idempotencyKey: request.idempotencyKey,
        }),
      );
    }
    let taintedNow = false;
    if (outcome.status === "ok") {
      events.push(
        runEvent(`${toolCallId}-done`, "tool.completed", {
          toolCallId,
          tool: call.name,
          durationMs: outcome.durationMs,
          untrusted: outcome.untrusted,
          ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
          preview: preview(outcome.content, 500),
        }),
      );
      if (outcome.untrusted && !taintedBefore) {
        taintedNow = true;
        events.push(runEvent(`${toolCallId}-taint`, "run.tainted", { source: call.name }));
      }
    } else if (outcome.status === "error") {
      events.push(
        runEvent(`${toolCallId}-failed`, "tool.failed", {
          toolCallId,
          tool: call.name,
          durationMs: outcome.durationMs,
          code: outcome.code.slice(0, 64),
          message: outcome.message.slice(0, 2_000),
        }),
      );
    }
    await log(events);
    if (taintedNow) await deps.runs.update(ctx, ctx.runId, { tainted: true });

    const needsPerson =
      outcome.status === "blocked" &&
      (outcome.verdict === "approve" || outcome.verdict === "human");
    if (outcome.status === "blocked" && needsPerson && deps.approvals && steps.waitForEvent) {
      return {
        content: `Waiting: ${outcome.message}`,
        untrusted: false,
        ok: false,
        taintedNow,
        approval: {
          verdict: outcome.verdict,
          reasons: outcome.reasons,
          summary:
            outcome.summary ?? `${call.name} ${JSON.stringify(call.args ?? {}).slice(0, 400)}`,
          ...(outcome.allowSite ? { site: outcome.allowSite } : {}),
          ...(outcome.editable ? { editable: outcome.editable } : {}),
          ...(outcome.showArgs ? { showArgs: true } : {}),
        },
      };
    }

    const content =
      outcome.status === "ok"
        ? outcome.content
        : outcome.status === "blocked"
          ? needsPerson
            ? `Not done: ${outcome.message} Nobody can approve it from here, so do not try again; tell the person what you would have done.`
            : `Not done: ${outcome.message}`
          : `Error (${outcome.code}): ${outcome.message}`;
    return {
      content,
      untrusted: outcome.status === "ok" && outcome.untrusted,
      ok: outcome.status === "ok",
      taintedNow,
      ...(outcome.status === "ok" && outcome.image ? { image: outcome.image } : {}),
    };
  }

  /**
   * Hand work to another agent and wait for the result (§6.3): make the child
   * run, run it, and turn what came back into the call's result. The brief is
   * the call as it ran, with any change a person made. A child of a tainted
   * run starts tainted; a child that read outside content returns its reply
   * as outside content, so this run is tainted from here (ADR-0013).
   */
  async function delegate(
    toolCallId: string,
    args: unknown,
    taintedBefore: boolean,
  ): Promise<{ content: string; untrusted: boolean }> {
    const { team } = deps;
    if (!team || !steps.invokeRun) {
      return {
        content: "Not done: handing work to another agent isn't available here. Do it yourself.",
        untrusted: false,
      };
    }
    const {
      agent,
      brief: written,
      include_results_from: include,
    } = args as {
      agent: string;
      brief: string;
      include_results_from?: string[];
    };
    // Earlier answers the brief asks for, in full (TC.09): live, a chief wrote
    // "the findings are in the previous response" and the helper, which sees
    // only its brief, searched the computer for them and then redid the work.
    const brief = withEarlierResults(written, include ?? []);
    const started = await steps.run(`${toolCallId}-handoff`, async () => {
      try {
        const handoff = await team.handoff(ctx, {
          key: `${ctx.runId}:${toolCallId}`,
          agent,
          brief: await redact(ctx, brief),
        });
        await log([
          runEvent(`${toolCallId}-handoff`, "delegation.started", {
            toolCallId,
            childRunId: handoff.runId,
            agentId: handoff.agentId,
            agentName: handoff.agentName,
          }),
        ]);
        return { ok: true as const, handoff };
      } catch (error) {
        return { ok: false as const, message: errorMessage(error) };
      }
    });
    if (!started.ok) return { content: `Not done: ${started.message}`, untrusted: false };
    const { handoff } = started;

    const child = await steps.invokeRun(
      `${toolCallId}-delegate`,
      {
        agentId: handoff.agentId,
        runId: handoff.runId,
        threadId: handoff.threadId,
        messageId: handoff.messageId,
      },
      { timeoutMs: options.delegationTimeoutMs ?? DELEGATION_TIMEOUT_MS },
    );

    return steps.run(`${toolCallId}-delegated`, async () => {
      const status = delegationStatus(child);
      const reply = child?.reply?.trim() ?? "";
      const answer =
        status === "done" || status === "stopped"
          ? reply.length > DELEGATION_ANSWER_CHARS
            ? `${reply.slice(0, DELEGATION_ANSWER_CHARS)}\n…[cut at ${DELEGATION_ANSWER_CHARS} characters]`
            : reply
          : "";
      const untrusted = answer !== "" && (child?.tainted ?? false);
      const note = DELEGATION_NOTES[status];
      const content = JSON.stringify({
        agent: handoff.agentName,
        status,
        ...(answer ? { answer } : {}),
        ...(note ? { note } : {}),
      });
      const events: RunEventWrite[] = [
        runEvent(`${toolCallId}-delegated`, "delegation.finished", {
          toolCallId,
          childRunId: handoff.runId,
          status,
          preview: preview(answer || note, 500),
        }),
      ];
      if (untrusted && !taintedBefore) {
        events.push(
          runEvent(`${toolCallId}-delegated-taint`, "run.tainted", { source: DELEGATE_TASK }),
        );
      }
      await log(events);
      if (untrusted && !taintedBefore) await deps.runs.update(ctx, ctx.runId, { tainted: true });
      return { content, untrusted };
    });
  }

  /** Keep what a handoff answered, under the handle it was asked by and its name. */
  function rememberAnswer(args: unknown, content: string): void {
    let parsed: { agent?: string; answer?: string } = {};
    try {
      parsed = JSON.parse(content) as typeof parsed;
    } catch {
      return; // A refusal ("Not done: …") has no answer.
    }
    if (!parsed.answer) return;
    const asked = (args as { agent?: string } | null)?.agent;
    // Every answer, in order: a researcher asked twice has found two things.
    const keys = new Set(
      [asked, parsed.agent].flatMap((k) => (k ? [k.trim().replace(/^@/, "").toLowerCase()] : [])),
    );
    for (const key of keys)
      handoffAnswers.set(key, [...(handoffAnswers.get(key) ?? []), parsed.answer]);
  }

  /** A brief with the earlier answers it names added after it. */
  function withEarlierResults(brief: string, include: readonly string[]): string {
    if (include.length === 0) return brief;
    const parts = include.map((name) => {
      const key = name.trim().replace(/^@/, "").toLowerCase();
      const answers = handoffAnswers.get(key);
      const answer = answers?.join("\n\n---\n\n");
      return answer
        ? `### From ${name}\n${answer}`
        : `### From ${name}\n(No answer from ${name} earlier in this task.)`;
    });
    return `${brief}\n\nResults from earlier in this task, as they were sent back:\n\n${parts.join("\n\n")}`;
  }

  async function finish(result: {
    status: "succeeded" | "failed";
    stopReason: RunStopReason;
    usage: RunUsageTotals;
    messageId: string | null;
    reply: string | null;
    tainted: boolean;
    error?: { code: string; message: string };
    /** What was asked, for the run's episode. */
    request?: string;
    /** A stopped run's progress from its record, for the episode (ADR-0045). */
    progress?: string | null;
  }): Promise<RunResult> {
    await steps.run("finish", async () => {
      if (hook) await chain.runEnd(hook, { status: result.status, stopReason: result.stopReason });
      await deps.runs.update(ctx, ctx.runId, {
        status: result.status,
        usage: result.usage,
        endedAt: new Date(),
        ...(result.error ? { error: result.error } : {}),
        onlyIfActive: true,
      });
      await log([
        runEvent("end", "run.ended", {
          status: result.status,
          stopReason: result.stopReason,
          usage: result.usage,
          ...(result.error ? { error: result.error } : {}),
        }),
      ]);
      // Its episode (M5.09): what was asked and what came of it. The learning
      // pass may replace the summary with a better one. Memory is a bonus, so
      // a failure here never fails the run.
      if (result.reply !== null && deps.memory?.writeEpisode) {
        const done = result.stopReason === "final_answer";
        const asked = result.request ? `Asked: ${preview(result.request, 200)} — ` : "";
        // A stopped run says how far it got, not just that it stopped (ADR-0045).
        const came = done
          ? `Answered: ${preview(result.reply, 300)}`
          : `Stopped (${result.stopReason.replaceAll("_", " ")})${result.progress ? `: ${preview(result.progress, 300)}` : ""}`;
        await deps.memory
          .writeEpisode(ctx, {
            threadId: input.threadId,
            summary: `${asked}${came}`,
            outcome: done ? "done" : "stopped",
            tainted: result.tainted,
          })
          .catch(() => {});
      }
      return true;
    });
    return {
      status: result.status,
      stopReason: result.stopReason,
      usage: result.usage,
      messageId: result.messageId,
      reply: result.reply,
      tainted: result.tainted,
      // Only a person's own request is learned from: a handoff or another
      // agent's message was written by another model, and a routine or a
      // scheduled task has nobody talking in it (M5.06–07).
      learn:
        input.trigger === "message" &&
        result.status === "succeeded" &&
        result.stopReason === "final_answer" &&
        result.messageId !== null &&
        !!deps.memory &&
        (options.extractMemories ?? true),
    };
  }
}
