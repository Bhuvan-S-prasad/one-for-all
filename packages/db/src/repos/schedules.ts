import { AppError, type TenantContext } from "@ofa/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agent, message, run, schedule, thread } from "../schema/index";
import { withTenant } from "../tenant";

// Prospective memory (M5.07, ADR-0035): tasks and reminders an agent set for
// later. The orchestrator sleeps until each is due; these rows are the truth.

export type ScheduleRow = typeof schedule.$inferSelect;
type ScheduleStatus = ScheduleRow["status"];

/**
 * Keep an item for later. The key is the setting tool call's idempotency
 * key: a retried call finds the item it set the first time. At most `limit`
 * pending per agent, counted under a per-agent lock.
 */
export async function createSchedule(
  db: Database,
  ctx: TenantContext,
  input: {
    agentId: string;
    threadId: string;
    runId: string | null;
    key: string;
    kind: ScheduleRow["kind"];
    content: string;
    dueAt: Date;
    tainted: boolean;
    limit: number;
  },
): Promise<{ row: ScheduleRow; created: boolean }> {
  return withTenant(db, ctx, async (tx) => {
    const [existing] = await tx.select().from(schedule).where(eq(schedule.key, input.key)).limit(1);
    if (existing) return { row: existing, created: false };
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`schedule:${input.agentId}`}))`);
    const [counted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schedule)
      .where(and(eq(schedule.agentId, input.agentId), eq(schedule.status, "pending")));
    if ((counted?.n ?? 0) >= input.limit) {
      throw new AppError(
        "conflict",
        `This agent already has ${input.limit} things waiting for later; cancel some first`,
      );
    }
    const [row] = await tx
      .insert(schedule)
      .values({
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        userId: ctx.userId,
        threadId: input.threadId,
        runId: input.runId,
        key: input.key,
        kind: input.kind,
        content: input.content,
        dueAt: input.dueAt,
        tainted: input.tainted,
      })
      .returning();
    if (!row) throw new Error("schedule insert returned no row");
    return { row, created: true };
  });
}

export async function getSchedule(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<ScheduleRow | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select().from(schedule).where(eq(schedule.id, id)).limit(1),
  );
  return row ?? null;
}

/** Soonest first. */
export async function listSchedules(
  db: Database,
  ctx: TenantContext,
  options: { agentId?: string; status?: ScheduleStatus } = {},
): Promise<ScheduleRow[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(schedule)
      .where(
        and(
          options.agentId ? eq(schedule.agentId, options.agentId) : undefined,
          options.status ? eq(schedule.status, options.status) : undefined,
        ),
      )
      .orderBy(asc(schedule.dueAt))
      .limit(200),
  );
}

/** Cancel a pending item; null when it isn't pending (already done or cancelled). */
export async function cancelSchedule(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<ScheduleRow | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx
      .update(schedule)
      .set({ status: "cancelled" })
      .where(and(eq(schedule.id, id), eq(schedule.status, "pending")))
      .returning(),
  );
  return row ?? null;
}

export type FireScheduleResult =
  | { outcome: "cancelled" | "agent_inactive" }
  | { outcome: "reminded"; threadId: string; messageId: string }
  | {
      outcome: "started";
      run: { runId: string; messageId: string; agentId: string; threadId: string };
    };

/**
 * A due item, in one transaction. A reminder is posted in its chat as the
 * agent's message, with no model call; a task gets a queued run whose request
 * is the task, acting as the person it was set for. Only a pending item
 * fires, once.
 */
export async function fireSchedule(
  db: Database,
  ctx: TenantContext,
  input: { id: string; now: Date; runId: string },
): Promise<FireScheduleResult> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(schedule)
      .where(eq(schedule.id, input.id))
      .for("update")
      .limit(1);
    if (!row || row.status !== "pending") return { outcome: "cancelled" };
    // It fires as the person it was set for, never as whoever the event names.
    if (row.userId !== ctx.userId) return { outcome: "cancelled" };
    const touch = () =>
      tx.update(thread).set({ updatedAt: input.now }).where(eq(thread.id, row.threadId));

    if (row.kind === "reminder") {
      // Delivered even while the agent is paused: it is the person's reminder.
      const [posted] = await tx
        .insert(message)
        .values({
          workspaceId: ctx.workspaceId,
          threadId: row.threadId,
          authorType: "agent",
          authorAgentId: row.agentId,
          content: `Reminder: ${row.content}`,
        })
        .returning({ id: message.id });
      if (!posted) throw new Error("message insert returned no row");
      await tx
        .update(schedule)
        .set({ status: "done", firedAt: input.now })
        .where(eq(schedule.id, row.id));
      await touch();
      return { outcome: "reminded", threadId: row.threadId, messageId: posted.id };
    }

    const [owner] = await tx
      .select({ status: agent.status })
      .from(agent)
      .where(eq(agent.id, row.agentId))
      .limit(1);
    if (owner?.status !== "active") {
      await tx
        .update(schedule)
        .set({ status: "failed", firedAt: input.now })
        .where(eq(schedule.id, row.id));
      return { outcome: "agent_inactive" };
    }
    await tx.insert(run).values({
      id: input.runId,
      workspaceId: ctx.workspaceId,
      agentId: row.agentId,
      threadId: row.threadId,
      trigger: "schedule",
      triggeredBy: ctx.userId,
      // Set after outside content: the task may carry someone else's words.
      tainted: row.tainted,
    });
    const [asked] = await tx
      .insert(message)
      .values({
        workspaceId: ctx.workspaceId,
        threadId: row.threadId,
        authorType: "system",
        content: `Scheduled task: ${row.content}`,
        runId: input.runId,
      })
      .returning({ id: message.id });
    if (!asked) throw new Error("message insert returned no row");
    await tx
      .update(schedule)
      .set({ status: "done", firedAt: input.now, firedRunId: input.runId })
      .where(eq(schedule.id, row.id));
    await touch();
    return {
      outcome: "started",
      run: {
        runId: input.runId,
        messageId: asked.id,
        agentId: row.agentId,
        threadId: row.threadId,
      },
    };
  });
}
