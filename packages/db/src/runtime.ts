import { agentSpecSchema, type AgentSpec } from "@ofa/contracts";
import {
  asId,
  LEARN_EVENT_PREFIX,
  type AgentDirectory,
  type AgentId,
  type AgentProfile,
  type ChatLedgerEntry,
  type ChatRecordStore,
  type ConversationMessage,
  type MessageId,
  type RunId,
  type RunStore,
  type TenantContext,
  type ThreadId,
  type ThreadStore,
  type ToolCallStore,
} from "@ofa/core";
import type { BusPayload } from "@ofa/events";
import { and, asc, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import { agent, agentGrant, message, run, runEvent, threadState, toolCall } from "./schema/index";
import { withTenant } from "./tenant";

// Postgres implementations of the runtime ports in `@ofa/core` (§6). After
// each committed write they announce it on the event bus, so clients update
// live (ADR-0007).

export type Publish = (workspaceId: string, payload: BusPayload) => Promise<void>;

export interface RuntimeStoreOptions {
  /** Announce committed writes. Failures are logged, never thrown: the write already happened. */
  readonly publish?: Publish;
}

const TERMINAL = ["succeeded", "failed", "cancelled"] as const;

function announcer(options: RuntimeStoreOptions) {
  return async (workspaceId: string, payloads: readonly BusPayload[]) => {
    if (!options.publish) return;
    for (const payload of payloads) {
      await options.publish(workspaceId, payload).catch((error: unknown) => {
        console.error("event bus publish failed", error);
      });
    }
  };
}

export function createRunStore(db: Database, options: RuntimeStoreOptions = {}): RunStore {
  const announce = announcer(options);
  const store: RunStore = {
    async get(ctx, runId) {
      const [row] = await withTenant(db, ctx, (tx) =>
        tx.select().from(run).where(eq(run.id, runId)).limit(1),
      );
      if (!row) return null;
      return {
        id: asId<RunId>(row.id),
        agentId: asId<AgentId>(row.agentId),
        threadId: row.threadId ? asId<ThreadId>(row.threadId) : null,
        trigger: row.trigger,
        status: row.status,
        tainted: row.tainted,
        proactive: row.proactive,
        request: row.request,
        usage: {
          inputTokens: row.usage.inputTokens ?? 0,
          outputTokens: row.usage.outputTokens ?? 0,
          costUsd: row.usage.costUsd ?? 0,
          modelCalls: row.usage.modelCalls ?? 0,
          toolCalls: row.usage.toolCalls ?? 0,
        },
      };
    },

    async update(ctx, runId, patch) {
      const { onlyIfActive, onlyIfStatus, ...fields } = patch;
      const changed = await withTenant(db, ctx, (tx) =>
        tx
          .update(run)
          .set(fields)
          .where(
            and(
              eq(run.id, runId),
              onlyIfActive ? notInArray(run.status, [...TERMINAL]) : undefined,
              onlyIfStatus ? eq(run.status, onlyIfStatus) : undefined,
            ),
          )
          .returning({ id: run.id }),
      );
      if (changed.length > 0) await announce(ctx.workspaceId, [{ kind: "run.updated", runId }]);
    },

    async append(ctx, runId, events) {
      if (events.length === 0) return;
      const inserted = await withTenant(db, ctx, async (tx) => {
        // One writer at a time per run, so `seq` has no gaps or clashes.
        const [locked] = await tx
          .select({ status: run.status })
          .from(run)
          .where(eq(run.id, runId))
          .for("update");
        // Once a run has ended, its log is closed: a step that was still in
        // flight when Stop was pressed must not add events after `run.ended`.
        // The learning pass after a successful run is the one exception.
        const closed = locked ? (TERMINAL as readonly string[]).includes(locked.status) : false;
        const candidates = closed
          ? events.filter(
              (e) =>
                e.type === "run.ended" ||
                (locked?.status === "succeeded" && e.key.startsWith(LEARN_EVENT_PREFIX)),
            )
          : events;
        if (candidates.length === 0) return [];
        const keys = candidates.map((e) => e.key);
        const known = new Set(
          (
            await tx
              .select({ key: runEvent.key })
              .from(runEvent)
              .where(and(eq(runEvent.runId, runId), inArray(runEvent.key, keys)))
          ).map((row) => row.key),
        );
        const fresh = candidates.filter((e) => !known.has(e.key));
        if (fresh.length === 0) return [];
        const [last] = await tx
          .select({ seq: sql<number>`coalesce(max(${runEvent.seq}), -1)` })
          .from(runEvent)
          .where(eq(runEvent.runId, runId));
        const start = Number(last?.seq ?? -1) + 1;
        return tx
          .insert(runEvent)
          .values(
            fresh.map((e, i) => ({
              workspaceId: ctx.workspaceId,
              runId,
              seq: start + i,
              key: e.key,
              type: e.type,
              payload: e.payload,
            })),
          )
          .returning({ seq: runEvent.seq });
      });
      await announce(
        ctx.workspaceId,
        inserted.map((row) => ({ kind: "run.event" as const, runId, seq: row.seq })),
      );
    },

    async claimFollowUps(ctx, threadId) {
      const steered = await withTenant(db, ctx, async (tx) => {
        const [self] = await tx
          .select({ createdAt: run.createdAt })
          .from(run)
          .where(eq(run.id, ctx.runId))
          .limit(1);
        if (!self) return [];
        // The person's later messages here whose runs, for this agent, haven't
        // started. Locked, so a run that is starting can't take one as well.
        const rows = await tx
          .select({ runId: run.id, messageId: message.id, content: message.content })
          .from(run)
          .innerJoin(message, and(eq(message.runId, run.id), eq(message.authorType, "user")))
          .where(
            and(
              eq(run.threadId, threadId),
              eq(run.agentId, ctx.agentId),
              eq(run.trigger, "message"),
              eq(run.status, "queued"),
              gt(run.createdAt, self.createdAt),
            ),
          )
          .orderBy(asc(message.createdAt), asc(message.id))
          .limit(20)
          .for("update", { of: run, skipLocked: true });
        if (rows.length === 0) return [];
        await tx
          .update(run)
          .set({
            status: "cancelled",
            endedAt: new Date(),
            error: { code: "steered", message: `Answered by run ${ctx.runId}` },
          })
          .where(
            inArray(
              run.id,
              rows.map((r) => r.runId),
            ),
          );
        return rows;
      });
      for (const row of steered) {
        await store.append(ctx, asId<RunId>(row.runId), [
          {
            key: "end-steered",
            type: "run.ended",
            payload: {
              status: "cancelled",
              stopReason: "steered",
              usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
            },
          },
        ]);
        await announce(ctx.workspaceId, [{ kind: "run.updated", runId: row.runId }]);
      }
      return steered.map((row) => ({ id: asId<MessageId>(row.messageId), content: row.content }));
    },

    async activeChildren(ctx, runId) {
      const rows = await withTenant(db, ctx, (tx) =>
        tx
          .select({ id: run.id })
          .from(run)
          .where(and(eq(run.parentRunId, runId), notInArray(run.status, [...TERMINAL]))),
      );
      return rows.map((row) => asId<RunId>(row.id));
    },
  };
  return store;
}

function toProfile(
  row: typeof agent.$inferSelect,
  grants: { tool: string; mode: "auto" | "approve" | "blocked" }[],
): AgentProfile {
  // Rows from before specs had a schema (M1 dev seeds) get the defaults.
  const parsed = agentSpecSchema.safeParse(row.spec);
  const spec: AgentSpec = parsed.success
    ? parsed.data
    : agentSpecSchema.parse({
        job: "General",
        avatar: { form: "blob", eyes: "googly", skin: "solid", color: "sand", mark: "none" },
      });
  return {
    id: asId<AgentId>(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    job: spec.job,
    modelTier: spec.modelTier,
    autonomy: spec.autonomy,
    voice: spec.voice,
    memoryScopes: spec.memoryScopes,
    budgets: spec.budgets,
    grants,
  };
}

export function createAgentDirectory(db: Database): AgentDirectory {
  return {
    async get(ctx, agentId) {
      return withTenant(db, ctx, async (tx) => {
        const [row] = await tx.select().from(agent).where(eq(agent.id, agentId)).limit(1);
        if (!row) return null;
        const grants = await tx
          .select({ tool: agentGrant.tool, mode: agentGrant.mode })
          .from(agentGrant)
          .where(eq(agentGrant.agentId, agentId))
          .orderBy(asc(agentGrant.tool));
        return toProfile(row, grants);
      });
    },
  };
}

export function createThreadStore(db: Database, options: RuntimeStoreOptions = {}): ThreadStore {
  const announce = announcer(options);
  return {
    async recentMessages(ctx: TenantContext, threadId, limit) {
      const rows = await withTenant(db, ctx, (tx) =>
        tx
          .select()
          .from(message)
          .where(eq(message.threadId, threadId))
          .orderBy(desc(message.createdAt), desc(message.id))
          .limit(limit),
      );
      return rows.reverse().map((row): ConversationMessage => ({
        id: asId<MessageId>(row.id),
        author: row.authorType,
        agentId: row.authorAgentId ? asId<AgentId>(row.authorAgentId) : null,
        content: row.content,
        createdAt: row.createdAt,
      }));
    },

    async addAgentMessage(ctx, input) {
      const { id, created } = await withTenant(db, ctx, async (tx) => {
        // A run posts one reply. A retried step finds it instead of posting
        // twice. By its own agent: a handoff's brief, written by the agent
        // handing the work over, carries the child run's ID too (M5.01).
        const [existing] = await tx
          .select({ id: message.id })
          .from(message)
          .where(
            and(
              eq(message.runId, ctx.runId),
              eq(message.authorType, "agent"),
              eq(message.authorAgentId, ctx.agentId),
            ),
          )
          .limit(1);
        if (existing) return { id: existing.id, created: false };
        const [row] = await tx
          .insert(message)
          .values({
            workspaceId: ctx.workspaceId,
            threadId: input.threadId,
            authorType: "agent",
            authorAgentId: ctx.agentId,
            content: input.content,
            runId: ctx.runId,
          })
          .returning({ id: message.id });
        if (!row) throw new Error("message insert returned no row");
        return { id: row.id, created: true };
      });
      if (created) {
        await announce(ctx.workspaceId, [
          { kind: "message.created", threadId: input.threadId, messageId: id },
        ]);
      }
      return asId<MessageId>(id);
    },
  };
}

export function createToolCallStore(db: Database): ToolCallStore {
  return {
    async begin(ctx, input) {
      return withTenant(db, ctx, async (tx) => {
        const [row] = await tx
          .insert(toolCall)
          .values({
            workspaceId: ctx.workspaceId,
            runId: ctx.runId,
            idempotencyKey: input.idempotencyKey,
            tool: input.tool,
            args: input.args,
            verdict: input.verdict,
          })
          .onConflictDoNothing({ target: [toolCall.workspaceId, toolCall.idempotencyKey] })
          .returning({ id: toolCall.id });
        if (row) return { created: true as const };
        const [existing] = await tx
          .select({
            status: toolCall.status,
            result: toolCall.result,
            untrusted: toolCall.untrusted,
          })
          .from(toolCall)
          .where(eq(toolCall.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (!existing) throw new Error("tool call vanished during begin");
        return { created: false as const, existing };
      });
    },

    async complete(ctx, idempotencyKey, outcome) {
      await withTenant(db, ctx, (tx) =>
        tx
          .update(toolCall)
          .set({
            status: "done",
            result: outcome.result,
            untrusted: outcome.untrusted,
            completedAt: new Date(),
          })
          .where(eq(toolCall.idempotencyKey, idempotencyKey)),
      );
    },

    async fail(ctx, idempotencyKey, error) {
      await withTenant(db, ctx, (tx) =>
        tx
          .update(toolCall)
          .set({ status: "failed", error, completedAt: new Date() })
          .where(eq(toolCall.idempotencyKey, idempotencyKey)),
      );
    },
  };
}

/** Each agent's working record per chat (ADR-0045), one row per thread and agent. */
export function createChatRecordStore(db: Database): ChatRecordStore {
  return {
    async get(ctx, threadId) {
      const [row] = await withTenant(db, ctx, (tx) =>
        tx
          .select()
          .from(threadState)
          .where(and(eq(threadState.threadId, threadId), eq(threadState.agentId, ctx.agentId)))
          .limit(1),
      );
      if (!row) return null;
      const state = row.state;
      return {
        plan: state.plan,
        ledger: state.ledger as ChatLedgerEntry[],
        notes: state.notes,
        stopReason: state.stopReason,
        runId: row.runId,
        tainted: state.tainted,
      };
    },

    async save(ctx, threadId, record) {
      const state = {
        plan: record.plan ? [...record.plan] : null,
        ledger: [...record.ledger],
        notes: record.notes,
        stopReason: record.stopReason,
        tainted: record.tainted,
      };
      await withTenant(db, ctx, (tx) =>
        tx
          .insert(threadState)
          .values({
            workspaceId: ctx.workspaceId,
            threadId,
            agentId: ctx.agentId,
            state,
            runId: record.runId,
          })
          .onConflictDoUpdate({
            target: [threadState.threadId, threadState.agentId],
            set: { state, runId: record.runId, updatedAt: new Date() },
          }),
      );
    },
  };
}
