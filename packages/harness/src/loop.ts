import type { RunStopReason } from "@ofa/contracts";
import type {
  AgentDirectory,
  AgentProfile,
  LLMGateway,
  LLMRequest,
  MemoryStore,
  RunContext,
  RunEventWrite,
  RunStore,
  RunUsageTotals,
  StepRunner,
  ThreadId,
  ThreadStore,
  ToolDescriptor,
  ToolExecutor,
  ToolOutcome,
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
}

export interface HarnessDeps {
  readonly llm: LLMGateway;
  readonly tools: ToolExecutor;
  readonly runs: RunStore;
  readonly agents: AgentDirectory;
  readonly threads: ThreadStore;
  readonly memory?: MemoryStore;
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
}

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
            await log([
              ...modelCallEvents(
                `compact-${i}-model`,
                "fast",
                result.response,
                result.promptVersion,
              ),
              runEvent(`compact-${i}`, "run.compacted", {
                tokensBefore: assembled.tokens.total,
                tokensAfter: Math.round(assembled.tokens.total * 0.4),
              }),
            ]);
          }
          return result;
        });
        if (compacted) {
          summary = compacted.summary;
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
        const result: ToolStepResult = await steps.run(toolCallId, () =>
          runTool(toolCallId, call, tainted),
        );
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

  async function runTool(
    toolCallId: string,
    call: ToolCallTurn & { readonly invalid?: string },
    taintedBefore: boolean,
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
    if (outcome.status !== "error" || outcome.verdict) {
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

    const content =
      outcome.status === "ok"
        ? outcome.content
        : outcome.status === "blocked"
          ? `Not done: ${outcome.message}`
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
