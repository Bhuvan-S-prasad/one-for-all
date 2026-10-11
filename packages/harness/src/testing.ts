import {
  asId,
  LEARN_EVENT_PREFIX,
  type AgentDirectory,
  type ApprovalRecord,
  type ApprovalStore,
  type AgentProfile,
  type ChildRunRequest,
  type ChildRunResult,
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
  type ToolExecutionRequest,
  type ToolExecutor,
  type ToolOutcome,
} from "@ofa/core";

// In-memory implementations of the runtime ports, for unit tests and evals.
// No database, no Inngest, no network.

type WaitOptions = Parameters<NonNullable<StepRunner["waitForEvent"]>>[1];

/**
 * Runs each step once and replays stored results, like Inngest's memoization.
 * With `onWait`, runs can also wait for events: it answers each wait (an
 * event's data, or null for a timeout), once, like a memoized step. With
 * `onInvoke`, runs can start child runs (M5.01): it plays each child, once.
 */
export function createMemoStepRunner(
  options: {
    onWait?: (
      id: string,
      wait: WaitOptions,
    ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
    onInvoke?: (
      id: string,
      child: ChildRunRequest,
      timeoutMs: number,
    ) => Promise<ChildRunResult | null> | ChildRunResult | null;
  } = {},
): StepRunner & {
  readonly ran: string[];
  readonly memo: Map<string, unknown>;
} {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const { onWait, onInvoke } = options;
  return {
    memo,
    ran,
    ...(onInvoke
      ? {
          async invokeRun(id: string, child: ChildRunRequest, { timeoutMs }) {
            if (memo.has(id)) return memo.get(id) as ChildRunResult | null;
            ran.push(id);
            const result = (await onInvoke(id, child, timeoutMs)) ?? null;
            memo.set(id, result);
            return result;
          },
        }
      : {}),
    ...(onWait
      ? {
          async waitForEvent(id: string, wait: WaitOptions) {
            if (memo.has(id)) return memo.get(id) as Record<string, unknown> | null;
            ran.push(id);
            const result = (await onWait(id, wait)) ?? null;
            memo.set(id, result);
            return result;
          },
        }
      : {}),
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
        const status = records.get(runId)?.status;
        const closed = status === "succeeded" || status === "failed" || status === "cancelled";
        for (const event of batch) {
          const learning = status === "succeeded" && event.key.startsWith(LEARN_EVENT_PREFIX);
          if (closed && event.type !== "run.ended" && !learning) continue;
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
        vision: false,
      };
    },
  };
}

export interface FakeTool {
  readonly descriptor: ToolDescriptor;
  run(args: unknown, request: ToolExecutionRequest): Promise<ToolOutcome> | ToolOutcome;
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
      return tool.run(request.args, request);
    },
  };
}

export function okOutcome(content: string, untrusted = false): ToolOutcome {
  return { status: "ok", content, untrusted, verdict: "auto", reasons: [], durationMs: 1 };
}

/** Approvals in memory, settled like the Postgres store: only while pending. */
export function createMemoryApprovals(): ApprovalStore & { readonly records: ApprovalRecord[] } {
  const records: ApprovalRecord[] = [];
  let ids = 0;
  const replace = (next: ApprovalRecord) => {
    records[records.findIndex((r) => r.id === next.id)] = next;
    return next;
  };
  return {
    records,
    async request(ctx, input) {
      const found = records.find((r) => r.runId === ctx.runId && r.toolCallId === input.toolCallId);
      if (found) return found;
      const record: ApprovalRecord = {
        ...input,
        site: input.site ?? null,
        scope: "once",
        editable: [...(input.editable ?? [])],
        showArgs: input.showArgs ?? false,
        edits: null,
        id: `approval_${++ids}`,
        runId: ctx.runId,
        agentId: ctx.agentId,
        threadId: null,
        status: "pending",
        decidedBy: null,
        createdAt: new Date(),
        decidedAt: null,
      };
      records.push(record);
      return record;
    },
    async get(_ctx, id) {
      return records.find((r) => r.id === id) ?? null;
    },
    async decide(_ctx, id, input) {
      const found = records.find((r) => r.id === id);
      if (!found || found.status !== "pending") return null;
      const scope =
        input.status === "approved" && input.scope === "site" && found.site ? "site" : "once";
      const edits =
        input.status === "approved" && input.edits && Object.keys(input.edits).length > 0
          ? { ...input.edits }
          : null;
      return replace({ ...found, ...input, scope, edits, decidedAt: new Date() });
    },
    async listPending(_ctx, filter = {}) {
      return records.filter(
        (r) =>
          r.status === "pending" &&
          (!filter.agentId || r.agentId === filter.agentId) &&
          (!filter.runId || r.runId === filter.runId),
      );
    },
    async expireForRun(_ctx, runId) {
      const open = records.filter((r) => r.runId === runId && r.status === "pending");
      for (const r of open) replace({ ...r, status: "expired", decidedAt: new Date() });
      return open.length;
    },
  };
}
