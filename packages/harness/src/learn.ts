import type { MessageId, RunContext, StepRunner, ThreadId } from "@ofa/core";
import type { HarnessDeps } from "./loop";
import { extractMemories } from "./memory-extraction";
import { redactJson } from "./redaction";

// The learning pass (ARCHITECTURE.md §8). It runs after a run succeeded, in a
// function of its own, so a slow extraction call never holds the agent's turn:
// the next message starts as soon as the reply is posted.

export interface LearnInput {
  readonly ctx: RunContext;
  readonly threadId: ThreadId;
  /** The run's reply; later messages belong to another exchange. */
  readonly messageId: MessageId;
}

export interface LearnResult {
  readonly learned: boolean;
  readonly calls: number;
}

type LearnDeps = Pick<
  HarnessDeps,
  "llm" | "runs" | "agents" | "threads" | "memory" | "options" | "redact" | "chats"
>;

export async function learnFromRun(
  input: LearnInput,
  deps: LearnDeps,
  steps: StepRunner,
): Promise<LearnResult> {
  const { ctx } = input;
  const memory = deps.memory;
  if (!memory) return { learned: false, calls: 0 };

  return steps.run("learn", async () => {
    const run = await deps.runs.get(ctx, ctx.runId);
    if (run?.status !== "succeeded") return { learned: false, calls: 0 };
    const agent = await deps.agents.get(ctx, ctx.agentId);
    if (!agent) return { learned: false, calls: 0 };

    const messages = await deps.threads.recentMessages(
      ctx,
      input.threadId,
      deps.options?.historyMessages ?? 30,
    );
    const end = messages.findIndex((m) => m.id === input.messageId);
    const reply = messages[end];
    if (!reply) return { learned: false, calls: 0 };
    // The history the facts come from crosses runs: if a run of this agent in
    // this chat read outside content, its replies (which may quote that
    // content) are in it, so what is learned here is unverified too (ADR-0013).
    const record = await deps.chats?.get(ctx, input.threadId);
    const verified = !run.tainted && !record?.tainted;

    const usage = await extractMemories({
      llm: deps.llm,
      memory,
      ctx,
      agent,
      history: messages
        .slice(0, end)
        .map((m) => ({ author: m.author, agentId: m.agentId, content: m.content })),
      answer: reply.content,
      verified,
      threadId: input.threadId,
      log: async (events) =>
        deps.runs.append(
          ctx,
          ctx.runId,
          deps.redact ? await redactJson(deps.redact, ctx, events) : events,
        ),
    });
    if (usage.calls > 0) {
      // Keep the run's totals honest: the learning call is part of its cost.
      await deps.runs.update(ctx, ctx.runId, {
        usage: {
          ...run.usage,
          inputTokens: run.usage.inputTokens + usage.inputTokens,
          outputTokens: run.usage.outputTokens + usage.outputTokens,
          costUsd: run.usage.costUsd + usage.costUsd,
          modelCalls: run.usage.modelCalls + usage.calls,
        },
      });
    }
    return { learned: true, calls: usage.calls };
  });
}
