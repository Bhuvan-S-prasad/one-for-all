import {
  asId,
  type LLMGateway,
  type RunContext,
  type StepRunner,
  type ThreadId,
  type ToolCallRecord,
  type ToolCallStore,
} from "@ofa/core";
import { createMemoryRuntime, createMemoStepRunner, runAgent } from "@ofa/harness";
import { createPolicyEngine } from "@ofa/policy";
import { builtinTools, createToolExecutor, createToolRegistry } from "@ofa/tools";
import { fixtureFetcher, fixtureSearch } from "../fixtures/web";
import type { EvalCase, Transcript } from "./types";

// One attempt at a case: a fresh, in-memory world around the real harness,
// tool executor and policy engine. Only the model is live; the web comes from
// fixtures and nothing touches the database.

function memoryToolCalls(): ToolCallStore {
  const rows = new Map<string, ToolCallRecord>();
  return {
    async begin(_ctx, input) {
      const existing = rows.get(input.idempotencyKey);
      if (existing) return { created: false, existing };
      rows.set(input.idempotencyKey, { status: "in_flight", result: null, untrusted: false });
      return { created: true };
    },
    async complete(_ctx, key, outcome) {
      rows.set(key, { status: "done", result: outcome.result, untrusted: outcome.untrusted });
    },
    async fail(_ctx, key) {
      rows.set(key, { status: "failed", result: null, untrusted: false });
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Like Inngest: when the gateway says "try again in N ms" (the free quota for
 * the minute is used up), wait and run the step again.
 */
function patientSteps(inner: StepRunner, wait: (ms: number) => Promise<void>): StepRunner {
  return {
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await inner.run(id, fn);
        } catch (error) {
          const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
          if (retryAfterMs === undefined || attempt >= 3) throw error;
          await wait(Math.min(Math.max(retryAfterMs, 1_000), 65_000));
        }
      }
    },
  };
}

export interface AttemptOptions {
  readonly llm: LLMGateway;
  readonly wait?: (ms: number) => Promise<void>;
}

export async function runAttempt(evalCase: EvalCase, options: AttemptOptions): Promise<Transcript> {
  const ctx: RunContext = {
    workspaceId: asId("ws_eval"),
    userId: asId("usr_eval"),
    agentId: asId("agent_eval"),
    runId: asId("run_eval"),
  };
  const threadId = asId<ThreadId>("thread_eval");
  const runtime = createMemoryRuntime();
  runtime.agents.profiles.set(ctx.agentId, { ...evalCase.agent, id: ctx.agentId });
  runtime.runs.records.set(ctx.runId, {
    id: ctx.runId,
    agentId: ctx.agentId,
    threadId,
    trigger: "message",
    status: "queued",
    tainted: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
  });
  runtime.threads.messages.set(threadId, [
    {
      id: asId("msg_prompt"),
      author: "user",
      agentId: null,
      content: evalCase.prompt,
      createdAt: new Date(),
    },
  ]);

  const tools = createToolExecutor({
    registry: createToolRegistry(
      builtinTools({
        memory: runtime.memory,
        search: fixtureSearch(evalCase.web),
        fetcher: fixtureFetcher(evalCase.web),
      }),
    ),
    policy: createPolicyEngine({ agents: runtime.agents }),
    calls: memoryToolCalls(),
    agents: runtime.agents,
  });

  const started = Date.now();
  let result: Transcript["result"] = null;
  let error: string | null = null;
  try {
    result = await runAgent(
      { ctx, threadId, trigger: "message" },
      {
        llm: options.llm,
        tools,
        runs: runtime.runs,
        agents: runtime.agents,
        threads: runtime.threads,
        memory: runtime.memory,
      },
      patientSteps(createMemoStepRunner(), options.wait ?? sleep),
    );
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }

  const events = runtime.runs.events.map((e) => ({ type: e.type, payload: e.payload }));
  const replies = (runtime.threads.messages.get(threadId) ?? []).filter(
    (m) => m.author === "agent",
  );
  return {
    reply: replies.at(-1)?.content ?? null,
    result,
    error,
    events,
    toolCalls: events
      .filter((e) => e.type === "tool.called")
      .map((e) => ({ name: String(e.payload.tool), args: e.payload.args })),
    memories: [...runtime.memory.records],
    durationMs: Date.now() - started,
  };
}
