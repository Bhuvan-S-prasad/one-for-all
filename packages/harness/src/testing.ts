import {
  asId,
  type AgentDirectory,
  type AgentProfile,
  type ConversationMessage,
  type LLMGateway,
  type LLMRequest,
  type LLMResponse,
  type MemoryId,
  type MemoryRecord,
  type MemoryStore,
  type MessageId,
  type RunEventWrite,
  type RunRecord,
  type RunStore,
  type StepRunner,
  type ThreadStore,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolOutcome,
} from "@ofa/core";

// In-memory implementations of the runtime ports, for unit tests and evals.
// No database, no Inngest, no network.

/** Runs each step once and replays stored results, like Inngest's memoization. */
export function createMemoStepRunner(): StepRunner & {
  readonly ran: string[];
  readonly memo: Map<string, unknown>;
} {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  return {
    memo,
    ran,
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (memo.has(id)) return memo.get(id) as T;
      ran.push(id);
      // Round-trip through JSON: Inngest stores step results as JSON.
      const result = JSON.parse(JSON.stringify((await fn()) ?? null)) as T;
      memo.set(id, result);
      return result;
    },
  };
}

export interface MemoryRuntime {
  readonly runs: RunStore & {
    readonly records: Map<string, RunRecord>;
    readonly events: (RunEventWrite & { seq: number; runId: string })[];
  };
  readonly agents: AgentDirectory & { readonly profiles: Map<string, AgentProfile> };
  readonly threads: ThreadStore & { readonly messages: Map<string, ConversationMessage[]> };
  readonly memory: MemoryStore & { readonly records: MemoryRecord[] };
}

export function createMemoryRuntime(): MemoryRuntime {
  const records = new Map<string, RunRecord>();
  const events: (RunEventWrite & { seq: number; runId: string })[] = [];
  const profiles = new Map<string, AgentProfile>();
  const messages = new Map<string, ConversationMessage[]>();
  const memories: MemoryRecord[] = [];
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}_${++ids}`;

  return {
    runs: {
      records,
      events,
      async get(_ctx, runId) {
        return records.get(runId) ?? null;
      },
      async update(_ctx, runId, patch) {
        const run = records.get(runId);
        if (!run) return;
        if (patch.onlyIfActive && ["succeeded", "failed", "cancelled"].includes(run.status)) return;
        if (patch.onlyIfStatus && run.status !== patch.onlyIfStatus) return;
        records.set(runId, {
          ...run,
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.tainted !== undefined ? { tainted: patch.tainted } : {}),
          ...(patch.usage ? { usage: patch.usage } : {}),
        });
      },
      async append(_ctx, runId, batch) {
        for (const event of batch) {
          if (events.some((e) => e.runId === runId && e.key === event.key)) continue;
          const seq = events.filter((e) => e.runId === runId).length;
          events.push({ ...event, seq, runId });
        }
      },
    },
    agents: {
      profiles,
      async get(_ctx, agentId) {
        return profiles.get(agentId) ?? null;
      },
    },
    threads: {
      messages,
      async recentMessages(_ctx, threadId, limit) {
        return (messages.get(threadId) ?? []).slice(-limit);
      },
      async addAgentMessage(ctx, input) {
        const list = messages.get(input.threadId) ?? [];
        const id = asId<MessageId>(nextId("msg"));
        list.push({
          id,
          author: "agent",
          agentId: ctx.agentId,
          content: input.content,
          createdAt: new Date(),
        });
        messages.set(input.threadId, list);
        return id;
      },
    },
    memory: {
      records: memories,
      async write(_ctx, write) {
        const record: MemoryRecord = {
          ...write,
          id: asId<MemoryId>(nextId("mem")),
          createdAt: new Date(),
        };
        memories.push(record);
        return record;
      },
      async recall(_ctx, query) {
        const words = query.query
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3);
        return memories
          .filter((m) => query.scopes.includes(m.scope) && (m.verified || query.includeUnverified))
          .filter((m) => words.some((w) => m.content.toLowerCase().includes(w)))
          .slice(0, query.limit);
      },
    },
  };
}

export type ScriptedReply =
  | { readonly text: string; readonly toolCalls?: undefined }
  | {
      readonly text?: string;
      readonly toolCalls: { name: string; args: unknown; invalid?: string }[];
    }
  | ((request: LLMRequest) => Partial<LLMResponse>);

/** A gateway that answers from a script, one reply per call, and records requests. */
export function createScriptedLLM(
  script: ScriptedReply[],
): LLMGateway & { readonly requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    requests,
    async generate(request) {
      requests.push(request);
      const next = script.shift();
      if (!next) throw new Error("Scripted LLM ran out of replies");
      const reply = typeof next === "function" ? next(request) : next;
      const toolCalls = ("toolCalls" in reply && reply.toolCalls ? reply.toolCalls : []).map(
        (c, n) => ({
          id: `call_${requests.length}_${n}`,
          name: c.name,
          args: c.args,
          ...("invalid" in c && c.invalid ? { invalid: c.invalid } : {}),
        }),
      );
      return {
        text: reply.text ?? "",
        toolCalls,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
        provider: "scripted",
        model: "scripted-model",
        finishReason: toolCalls.length ? "tool-calls" : "stop",
        durationMs: 5,
        attempts: [],
      };
    },
    async modelFor() {
      return {
        provider: "scripted",
        id: "scripted-model",
        contextWindow: 32_000,
        maxOutputTokens: 4_000,
      };
    },
  };
}

export interface FakeTool {
  readonly descriptor: ToolDescriptor;
  run(args: unknown): Promise<ToolOutcome> | ToolOutcome;
}

/** A tool executor over plain functions, without policy. */
export function createFakeToolExecutor(
  tools: FakeTool[],
): ToolExecutor & { readonly calls: { name: string; args: unknown; key: string }[] } {
  const calls: { name: string; args: unknown; key: string }[] = [];
  return {
    calls,
    async listTools() {
      return tools.map((t) => t.descriptor);
    },
    async execute(request) {
      calls.push({ name: request.name, args: request.args, key: request.idempotencyKey });
      const tool = tools.find((t) => t.descriptor.name === request.name);
      if (!tool)
        return { status: "error", code: "unknown_tool", message: request.name, durationMs: 0 };
      return tool.run(request.args);
    },
  };
}

export function okOutcome(content: string, untrusted = false): ToolOutcome {
  return { status: "ok", content, untrusted, verdict: "auto", reasons: [], durationMs: 1 };
}
