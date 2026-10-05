import { INNGEST_EVENTS, type RunStopReason } from "@ofa/contracts";
import {
  APPROVAL_TIMEOUT_MS,
  urlKey,
  urlsIn,
  type AgentDirectory,
  type AgentProfile,
  type ApprovalStore,
  type LLMGateway,
  type LLMRequest,
  type MemoryStore,
  type RunContext,
  type RunEventWrite,
  type RunStore,
  type RunUsageTotals,
  type StepRunner,
  type ThreadId,
  type ThreadStore,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolOutcome,
  type Verdict,
} from "@ofa/core";
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
  readonly middleware?: readonly HarnessMiddleware[];
  readonly options?: HarnessOptions;
}

export interface RunInput {
  readonly ctx: RunContext;
  readonly threadId: ThreadId | null;
  readonly trigger: "message" | "routine" | "delegation" | "event" | "manual";
}

export interface RunResult {
  readonly status: "succeeded" | "failed" | "cancelled" | "skipped";
  readonly stopReason: RunStopReason | null;
  readonly usage: RunUsageTotals;
  readonly messageId: string | null;
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
  /** Policy wants a person to agree first; nothing ran yet. */
  readonly approval?: {
    readonly verdict: Verdict;
    readonly reasons: readonly string[];
    readonly summary: string;
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
  const log = (events: RunEventWrite[]) => deps.runs.append(ctx, ctx.runId, events);
  let hook: RunHookContext | null = null;
  /** Addresses the run was given, in `urlKey` form (filled in as the run goes). */
  const knownUrls = new Set<string>();

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
      await log([
        runEvent("start", "run.started", { trigger: input.trigger, tier: agent.modelTier }),
      ]);
      return {
        skip: false as const,
        agent,
        tainted: run.tainted,
        today: new Date().toISOString().slice(0, 10),
      };
    });
    if (start.skip) {
      return {
        status: "skipped",
        stopReason: null,
        usage: EMPTY_USAGE,
        messageId: null,
        learn: false,
      };
    }
    const agent: AgentProfile = start.agent;
    hook = { ctx, agent };
    let tainted = start.tainted;

    if (agent.status !== "active") {
      return await finish({
        status: "failed",
        stopReason: "error",
        usage: EMPTY_USAGE,
        error: { code: "agent_inactive", message: `${agent.name} is ${agent.status}` },
        messageId: null,
      });
    }

    // ── Context that holds for the whole run ─────────────────────────────────
    const context = await steps.run("context", async () => {
      const history: HistoryMessage[] = input.threadId
        ? (
            await deps.threads.recentMessages(ctx, input.threadId, options.historyMessages ?? 30)
          ).map((m) => ({ author: m.author, agentId: m.agentId, content: m.content }))
        : [];
      const lastUser = [...history].reverse().find((m) => m.author === "user")?.content ?? "";
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
      const tools: ToolDescriptor[] = await deps.tools.listTools(ctx);
      const model = await deps.llm.modelFor(agent.modelTier, ctx);
      return { history, memories, tools, window: model.contextWindow };
    });
    const budget = contextBudget(context.window, options.maxContextTokens ?? 32_000);

    // Addresses the run was given (§10.3): in the conversation, and in what
    // its tools return. In a tainted run, opening any other one needs a person.
    const learnUrls = (text: string) => {
      for (const url of urlsIn(text)) knownUrls.add(urlKey(url));
    };
    for (const message of context.history) learnUrls(message.content);

    // ── The loop ─────────────────────────────────────────────────────────────
    let usage = EMPTY_USAGE;
    let turns: Turn[] = [];
    let summary: string | null = null;
    let todos: { text: string; done: boolean }[] | null = null;
    const seen = new Map<string, number>();
    let finalText: string | null = null;
    let stopReason: RunStopReason = "step_budget";

    for (let i = 0; i < agent.budgets.steps; i += 1) {
      let assembled = assembleContext(
        {
          today: start.today,
          agent,
          tools: context.tools,
          memories: context.memories,
          todos,
          history: context.history,
          summary,
          turns,
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
                tools: context.tools,
                memories: context.memories,
                todos,
                history: context.history,
                summary: result.summary,
                turns: turns.slice(result.replaced),
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
          learnUrls(compacted.summary);
          turns = turns.slice(compacted.replaced);
          usage = addUsage(usage, compacted, { model: 1 });
          assembled = assembleContext(
            {
              today: start.today,
              agent,
              tools: context.tools,
              memories: context.memories,
              todos,
              history: context.history,
              summary,
              turns,
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

      for (const [j, call] of step.toolCalls.entries()) {
        const toolCallId = `tool-${i}-${j}`;
        let result: ToolStepResult = await steps.run(toolCallId, () =>
          runTool(toolCallId, call, tainted),
        );
        if (result.approval) {
          const decision = await askPerson(toolCallId, call, result.approval);
          result =
            decision === "approved"
              ? await steps.run(`${toolCallId}-approved`, () =>
                  runTool(toolCallId, call, tainted, true),
                )
              : { content: DECLINED[decision], untrusted: false, ok: false, taintedNow: false };
        }
        usage = addUsage(usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 }, { tool: 1 });
        if (result.taintedNow) tainted = true;
        if (result.ok && call.name === "todo.write") {
          const items = (call.args as { items?: { text: string; done: boolean }[] }).items;
          if (Array.isArray(items)) todos = items;
        }
        turns.push({
          kind: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          untrusted: result.untrusted,
        });
        learnUrls(result.content);
      }
    }

    // ── Reply ────────────────────────────────────────────────────────────────
    const replyText =
      stopReason === "final_answer"
        ? finalText || "I don't have anything to add."
        : (STOP_NOTES[stopReason] ?? "I stopped before finishing.");
    const messageId = input.threadId
      ? await steps.run("reply", async () => {
          const id = await deps.threads.addAgentMessage(ctx, {
            threadId: input.threadId as ThreadId,
            content: replyText,
          });
          await log([
            runEvent("reply", "message.created", {
              messageId: id,
              preview: preview(replyText, 280),
            }),
          ]);
          return id as string;
        })
      : null;

    return await finish({ status: "succeeded", stopReason, usage, messageId });
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
  ): Promise<"approved" | "rejected" | "expired"> {
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
      const record = await approvals.request(ctx, {
        toolCallId,
        tool: call.name,
        args: call.args,
        summary: approval.summary,
        reasons: approval.reasons,
        verdict: approval.verdict,
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
      const status: "approved" | "rejected" | "expired" =
        record && record.status !== "pending" ? record.status : "expired";
      await log([
        runEvent(`${toolCallId}-decided`, "approval.decided", {
          approvalId: asked.id,
          decision: status,
          decidedBy: record?.decidedBy ?? null,
        }),
        runEvent(`${toolCallId}-resumed`, "run.resumed", {}),
      ]);
      await deps.runs.update(ctx, ctx.runId, { status: "running", onlyIfStatus: "waiting" });
      return status;
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
      ...(approved ? { approved: true } : {}),
    };
    const execute = chain.tool(hook as RunHookContext, (r) => deps.tools.execute(r, ctx));
    let outcome: ToolOutcome;
    try {
      outcome = await execute(request);
    } catch (error) {
      outcome = {
        status: "error",
        code: "tool_crashed",
        message: errorMessage(error),
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
    };
  }

  async function finish(result: {
    status: "succeeded" | "failed";
    stopReason: RunStopReason;
    usage: RunUsageTotals;
    messageId: string | null;
    error?: { code: string; message: string };
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
      return true;
    });
    return {
      status: result.status,
      stopReason: result.stopReason,
      usage: result.usage,
      messageId: result.messageId,
      learn:
        result.status === "succeeded" &&
        result.stopReason === "final_answer" &&
        result.messageId !== null &&
        !!deps.memory &&
        (options.extractMemories ?? true),
    };
  }
}
