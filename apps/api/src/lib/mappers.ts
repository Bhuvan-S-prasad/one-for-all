import {
  agentSpecSchema,
  runEventSchema,
  type Agent,
  type AgentSpec,
  type MemoryItem,
  type Message,
  type Run,
  type RunEvent,
  type Thread,
  type ThreadSummary,
} from "@ofa/contracts";
import type {
  AgentWithGrants,
  MemoryReviewRow,
  MessageRow,
  RunEventRow,
  RunRow,
  ThreadSummaryRow,
  ThreadWithMembers,
} from "@ofa/db";

// Database rows → API shapes from `@ofa/contracts`. The client validates
// every response against the same schemas (ADR-0021).

/** Rows written before specs had a schema (M1 dev seeds) still load. */
const FALLBACK_SPEC: AgentSpec = agentSpecSchema.parse({
  job: "General",
  avatar: { form: "blob", eyes: "googly", skin: "solid", color: "sand", mark: "none" },
});

export function toAgent(row: AgentWithGrants): Agent {
  const spec = agentSpecSchema.safeParse(row.spec);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    spec: spec.success ? spec.data : FALLBACK_SPEC,
    grants: row.grants,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toThread(row: ThreadWithMembers): Thread {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    members: row.members,
    coordinatorAgentId: row.coordinatorAgentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export function toMessage(row: MessageRow): Message {
  const author: Message["author"] =
    row.authorType === "user"
      ? { type: "user", userId: row.authorUserId }
      : row.authorType === "agent"
        ? { type: "agent", agentId: row.authorAgentId ?? "" }
        : { type: "system" };
  return {
    id: row.id,
    threadId: row.threadId,
    author,
    content: row.content,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    agentId: row.agentId,
    threadId: row.threadId,
    parentRunId: row.parentRunId,
    trigger: row.trigger,
    status: row.status,
    tainted: row.tainted,
    usage: {
      inputTokens: row.usage.inputTokens ?? 0,
      outputTokens: row.usage.outputTokens ?? 0,
      costUsd: row.usage.costUsd ?? 0,
      modelCalls: row.usage.modelCalls ?? 0,
      toolCalls: row.usage.toolCalls ?? 0,
    },
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

/** Null for an event that does not match the catalog (never expected; skipped, not fatal). */
export function toRunEvent(row: RunEventRow): RunEvent | null {
  const parsed = runEventSchema.safeParse({
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
    type: row.type,
    payload: row.payload,
  });
  return parsed.success ? parsed.data : null;
}

export function toThreadSummary(row: ThreadSummaryRow): ThreadSummary {
  return {
    ...toThread(row),
    preview: row.preview,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
  };
}

export function toMemoryItem(row: MemoryReviewRow): MemoryItem {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    agentId: row.agentId,
    content: row.content,
    verified: row.verified,
    sourceRunId: row.sourceRunId,
    createdAt: row.createdAt.toISOString(),
  };
}
