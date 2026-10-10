import { AppError, nextCronTime, parseCron, type TenantContext } from "@ofa/core";
import { and, asc, desc, eq, isNotNull, lte, max, notInArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agent, message, routine, run, thread, threadMember } from "../schema/index";
import { withTenant, type Tx } from "../tenant";

// Routines (M5.06, ADR-0035): an agent's standing job on a schedule. Each one
// has its own chat, where every run posts its request and its reply.

export type RoutineRow = typeof routine.$inferSelect;
type RunRow = typeof run.$inferSelect;

const TERMINAL = ["succeeded", "failed", "cancelled"] as const;

/** The routine's next time after `after`, or null when its schedule never comes again. */
export function nextRoutineTime(row: Pick<RoutineRow, "cron" | "timeZone">, after: Date) {
  return nextCronTime(parseCron(row.cron), after, row.timeZone);
}

/** What a routine run reads as its request, and the chat shows. */
function requestText(row: Pick<RoutineRow, "name" | "instructions" | "kind">): string {
  return `${row.kind === "check" ? "Check" : "Routine"} “${row.name}”: ${row.instructions}`;
}

export async function listRoutines(
  db: Database,
  ctx: TenantContext,
  options: { agentId?: string } = {},
): Promise<RoutineRow[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(routine)
      .where(options.agentId ? eq(routine.agentId, options.agentId) : undefined)
      .orderBy(asc(routine.createdAt))
      .limit(500),
  );
}

export async function getRoutine(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<RoutineRow | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select().from(routine).where(eq(routine.id, id)).limit(1),
  );
  return row ?? null;
}

/**
 * A routine and its chat, together. At most `limit` per agent: the count is
 * taken under a per-agent lock, so two requests can't both make the last one.
 */
export async function createRoutine(
  db: Database,
  ctx: TenantContext,
  input: {
    agentId: string;
    name: string;
    instructions: string;
    cron: string;
    timeZone: string;
    kind?: RoutineRow["kind"];
    nextRunAt: Date | null;
    limit: number;
  },
): Promise<RoutineRow> {
  return withTenant(db, ctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`routine:${input.agentId}`}))`);
    const [counted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(routine)
      .where(eq(routine.agentId, input.agentId));
    if ((counted?.n ?? 0) >= input.limit) {
      throw new AppError("conflict", `An agent can have at most ${input.limit} routines`);
    }
    const [chat] = await tx
      .insert(thread)
      .values({
        workspaceId: ctx.workspaceId,
        kind: "direct",
        title: input.name,
        createdBy: ctx.userId,
      })
      .returning({ id: thread.id });
    if (!chat) throw new Error("thread insert returned no row");
    await tx.insert(threadMember).values([
      { workspaceId: ctx.workspaceId, threadId: chat.id, memberType: "user", userId: ctx.userId },
      {
        workspaceId: ctx.workspaceId,
        threadId: chat.id,
        memberType: "agent",
        agentId: input.agentId,
      },
    ]);
    const [row] = await tx
      .insert(routine)
      .values({
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        threadId: chat.id,
        name: input.name,
        instructions: input.instructions,
        kind: input.kind ?? "task",
        cron: input.cron,
        timeZone: input.timeZone,
        nextRunAt: input.nextRunAt,
        createdBy: ctx.userId,
      })
      .returning();
    if (!row) throw new Error("routine insert returned no row");
    return row;
  });
}

export async function updateRoutine(
  db: Database,
  ctx: TenantContext,
  id: string,
  patch: Partial<
    Pick<
      RoutineRow,
      | "name"
      | "instructions"
      | "kind"
      | "cron"
      | "timeZone"
      | "status"
      | "pausedReason"
      | "nextRunAt"
    >
  >,
): Promise<RoutineRow | null> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx.update(routine).set(patch).where(eq(routine.id, id)).returning();
    if (row && patch.name) {
      await tx.update(thread).set({ title: patch.name }).where(eq(thread.id, row.threadId));
    }
    return row ?? null;
  });
}

/** Removes the routine; its chat and past runs stay. */
export async function deleteRoutine(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<boolean> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx.delete(routine).where(eq(routine.id, id)).returning({ id: routine.id }),
  );
  return rows.length > 0;
}

/** The routine's latest runs, newest first. */
export async function listRoutineRuns(
  db: Database,
  ctx: TenantContext,
  routineId: string,
  limit: number,
): Promise<RunRow[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(run)
      .where(eq(run.routineId, routineId))
      .orderBy(desc(run.createdAt), desc(run.id))
      .limit(limit),
  );
}

export interface DueRoutineRow {
  readonly workspaceId: string;
  readonly userId: string;
  readonly routineId: string;
  readonly dueAt: Date;
}

/**
 * Due routines in every workspace, oldest first. Spans workspaces, so it
 * takes the owner connection (as the token refresh does); each routine then
 * fires as its owner, through tenant-scoped queries.
 */
export async function listDueRoutines(
  ownerDb: Database,
  now: Date,
  limit = 100,
): Promise<DueRoutineRow[]> {
  const rows = await ownerDb
    .select({
      workspaceId: routine.workspaceId,
      userId: routine.createdBy,
      routineId: routine.id,
      dueAt: routine.nextRunAt,
    })
    .from(routine)
    .where(
      and(
        eq(routine.status, "active"),
        isNotNull(routine.createdBy),
        isNotNull(routine.nextRunAt),
        lte(routine.nextRunAt, now),
      ),
    )
    .orderBy(asc(routine.nextRunAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, userId: r.userId!, dueAt: r.dueAt! }));
}

async function activeRoutineRun(tx: Tx, routineId: string): Promise<boolean> {
  const [busy] = await tx
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.routineId, routineId), notInArray(run.status, [...TERMINAL])))
    .limit(1);
  return !!busy;
}

/**
 * The routine's run and its request message, written together. A check
 * (M5.10) posts nothing as it starts: its request travels on the run, and its
 * chat gets a message only when something needs attention. Its "message" is
 * the run's own ID.
 */
async function insertRoutineRun(
  tx: Tx,
  ctx: TenantContext,
  row: RoutineRow,
  runId: string,
  trigger: "routine" | "manual",
): Promise<{ runId: string; messageId: string; created: boolean }> {
  if (row.kind === "check") {
    const [made] = await tx
      .insert(run)
      .values({
        id: runId,
        workspaceId: ctx.workspaceId,
        agentId: row.agentId,
        threadId: row.threadId,
        routineId: row.id,
        trigger,
        triggeredBy: ctx.userId,
        proactive: true,
        request: requestText(row),
      })
      .onConflictDoNothing({ target: run.id })
      .returning({ id: run.id });
    return { runId, messageId: runId, created: !!made };
  }
  const [made] = await tx
    .insert(run)
    .values({
      id: runId,
      workspaceId: ctx.workspaceId,
      agentId: row.agentId,
      threadId: row.threadId,
      routineId: row.id,
      trigger,
      triggeredBy: ctx.userId,
    })
    .onConflictDoNothing({ target: run.id })
    .returning({ id: run.id });
  if (!made) {
    const [asked] = await tx
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.runId, runId), eq(message.authorType, "system")))
      .limit(1);
    if (!asked) throw new Error("routine run has no request");
    return { runId, messageId: asked.id, created: false };
  }
  const [asked] = await tx
    .insert(message)
    .values({
      workspaceId: ctx.workspaceId,
      threadId: row.threadId,
      authorType: "system",
      content: requestText(row),
      runId,
    })
    .returning({ id: message.id });
  if (!asked) throw new Error("message insert returned no row");
  await tx.update(thread).set({ updatedAt: new Date() }).where(eq(thread.id, row.threadId));
  return { runId, messageId: asked.id, created: true };
}

export type FireRoutineResult =
  | { outcome: "gone" | "busy" | "missed" | "paused" | "agent_inactive" }
  | {
      outcome: "started";
      run: { runId: string; messageId: string; agentId: string; threadId: string };
    };

/**
 * One due time of a routine, in one transaction: start its run, or pass the
 * time over, and move the routine on to its next time. A second tick for the
 * same time finds `next_run_at` already moved and does nothing ("gone").
 *
 * - `idleSince`: if its owner wrote nothing since then (and nobody edited
 *   the routine), it pauses itself (§11 runaway work).
 * - `missedAfterMs`: a time this late was missed (the server was off) and is
 *   skipped rather than run hours late.
 * - A run of the routine still going means this time is skipped, not queued
 *   (§11 backpressure).
 */
export async function fireDueRoutine(
  db: Database,
  ctx: TenantContext,
  input: {
    routineId: string;
    dueAt: Date;
    now: Date;
    runId: string;
    idleSince: Date;
    missedAfterMs: number;
  },
): Promise<FireRoutineResult> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(routine)
      .where(eq(routine.id, input.routineId))
      .for("update")
      .limit(1);
    if (!row || row.status !== "active" || row.nextRunAt?.getTime() !== input.dueAt.getTime()) {
      return { outcome: "gone" };
    }
    const after = new Date(Math.max(input.now.getTime(), input.dueAt.getTime()));
    // `updated_at` is kept: it records a person's last edit, which counts as activity.
    const moveOn = (extra: Partial<RoutineRow> = {}) =>
      tx
        .update(routine)
        .set({ nextRunAt: nextRoutineTime(row, after), updatedAt: row.updatedAt, ...extra })
        .where(eq(routine.id, row.id));

    const [spoke] = await tx
      .select({ at: max(message.createdAt) })
      .from(message)
      .where(and(eq(message.authorType, "user"), eq(message.authorUserId, ctx.userId)));
    const lastActive = Math.max(row.updatedAt.getTime(), spoke?.at?.getTime() ?? 0);
    if (lastActive < input.idleSince.getTime()) {
      await tx
        .update(routine)
        .set({ status: "paused", pausedReason: "inactive", nextRunAt: null })
        .where(eq(routine.id, row.id));
      return { outcome: "paused" };
    }
    const [owner] = await tx
      .select({ status: agent.status })
      .from(agent)
      .where(eq(agent.id, row.agentId))
      .limit(1);
    if (owner?.status !== "active") {
      await moveOn();
      return { outcome: "agent_inactive" };
    }
    if (input.now.getTime() - input.dueAt.getTime() > input.missedAfterMs) {
      await moveOn();
      return { outcome: "missed" };
    }
    if (await activeRoutineRun(tx, row.id)) {
      await moveOn();
      return { outcome: "busy" };
    }
    const made = await insertRoutineRun(tx, ctx, row, input.runId, "routine");
    await moveOn({ lastRunAt: input.now });
    return {
      outcome: "started",
      run: {
        runId: made.runId,
        messageId: made.messageId,
        agentId: row.agentId,
        threadId: row.threadId,
      },
    };
  });
}

/** A test run now (M5.06), outside the schedule. Refused while one of its runs is going. */
export async function startRoutineTestRun(
  db: Database,
  ctx: TenantContext,
  input: { routineId: string; runId: string },
): Promise<{ runId: string; messageId: string; agentId: string; threadId: string } | null> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(routine)
      .where(eq(routine.id, input.routineId))
      .for("update")
      .limit(1);
    if (!row) return null;
    if (await activeRoutineRun(tx, row.id)) {
      throw new AppError("conflict", "This routine is running now; wait for it to finish");
    }
    const made = await insertRoutineRun(tx, ctx, row, input.runId, "manual");
    return {
      runId: made.runId,
      messageId: made.messageId,
      agentId: row.agentId,
      threadId: row.threadId,
    };
  });
}
