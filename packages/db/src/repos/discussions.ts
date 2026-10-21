import type { TenantContext } from "@ofa/core";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { discussion, discussionTurn, message, run, thread } from "../schema/index";
import { withTenant } from "../tenant";

// Group discussions (ADR-0050): the row that says who takes part and where it
// stands, and one row per turn with the run that takes it.

export type DiscussionRow = typeof discussion.$inferSelect;
export type DiscussionStatusValue = DiscussionRow["status"];

const OPEN: DiscussionStatusValue[] = ["active", "closing"];

export interface DiscussionTurnRow {
  readonly runId: string;
  readonly agentId: string;
  readonly round: number;
  readonly position: number | null;
  readonly status: (typeof run.$inferSelect)["status"];
  readonly messageId: string | null;
}

export interface DiscussionWithTurns extends DiscussionRow {
  readonly turns: DiscussionTurnRow[];
}

/**
 * Open a discussion of a question in a group thread. The question is posted
 * here (by the person, or by the coordinator for `ask_group`) unless it is
 * already in the thread. The ID comes from the caller, so a retried request
 * opens one. Null when another discussion is already open there.
 */
export async function openDiscussion(
  db: Database,
  ctx: TenantContext,
  input: {
    readonly id: string;
    readonly threadId: string;
    /** The person's message, already posted; or the coordinator's question to post. */
    readonly question:
      { readonly messageId: string } | { readonly agentId: string; readonly content: string };
    readonly startedByRunId: string | null;
    readonly coordinatorAgentId: string;
    readonly memberIds: readonly string[];
    readonly rounds: number;
    readonly tainted: boolean;
  },
): Promise<{ readonly discussion: DiscussionRow; readonly created: boolean } | null> {
  return withTenant(db, ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(discussion)
      .where(eq(discussion.id, input.id))
      .limit(1);
    if (existing) return { discussion: existing, created: false };
    const [open] = await tx
      .select({ id: discussion.id })
      .from(discussion)
      .where(and(eq(discussion.threadId, input.threadId), inArray(discussion.status, OPEN)))
      .limit(1);
    if (open) return null;
    let questionMessageId: string;
    if ("messageId" in input.question) {
      questionMessageId = input.question.messageId;
    } else {
      // No run ID: the coordinator's own reply carries its run's (one reply per run).
      const [posted] = await tx
        .insert(message)
        .values({
          workspaceId: ctx.workspaceId,
          threadId: input.threadId,
          authorType: "agent",
          authorAgentId: input.question.agentId,
          content: input.question.content,
        })
        .returning({ id: message.id });
      if (!posted) throw new Error("message insert returned no row");
      questionMessageId = posted.id;
      await tx.update(thread).set({ updatedAt: new Date() }).where(eq(thread.id, input.threadId));
    }
    const [row] = await tx
      .insert(discussion)
      .values({
        id: input.id,
        workspaceId: ctx.workspaceId,
        threadId: input.threadId,
        questionMessageId,
        startedByRunId: input.startedByRunId,
        coordinatorAgentId: input.coordinatorAgentId,
        memberIds: [...input.memberIds],
        rounds: input.rounds,
        tainted: input.tainted,
      })
      .returning();
    if (!row) throw new Error("discussion insert returned no row");
    return { discussion: row, created: true };
  });
}

export async function getDiscussion(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<DiscussionRow | null> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx.select().from(discussion).where(eq(discussion.id, id)).limit(1);
    return row ?? null;
  });
}

/** The discussion open in a thread, if any. */
export async function openDiscussionIn(
  db: Database,
  ctx: TenantContext,
  threadId: string,
): Promise<DiscussionRow | null> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(discussion)
      .where(and(eq(discussion.threadId, threadId), inArray(discussion.status, OPEN)))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Move a discussion on. An ended one (done, stopped, failed) stays as it
 * is, so a turn finishing after a stop can't reopen it. False when nothing
 * changed.
 */
export async function updateDiscussion(
  db: Database,
  ctx: TenantContext,
  id: string,
  patch: {
    readonly round?: number;
    readonly status?: DiscussionStatusValue;
    readonly tainted?: boolean;
    readonly closingMessageId?: string;
  },
): Promise<boolean> {
  const ends = patch.status !== undefined && !OPEN.includes(patch.status);
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .update(discussion)
      .set({
        ...(patch.round !== undefined ? { round: patch.round } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.tainted ? { tainted: true } : {}),
        ...(patch.closingMessageId ? { closingMessageId: patch.closingMessageId } : {}),
        ...(ends ? { endedAt: new Date() } : {}),
      })
      .where(and(eq(discussion.id, id), inArray(discussion.status, OPEN)))
      .returning({ id: discussion.id }),
  );
  return rows.length > 0;
}

/**
 * The run for one turn, queued in the discussion's thread and tainted if
 * the discussion is, with its turn row. The run ID comes from the caller
 * (derived from the turn), so a retried step makes one. Null when the
 * discussion is no longer open.
 */
export async function startDiscussionTurn(
  db: Database,
  ctx: TenantContext,
  input: {
    readonly discussionId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly round: number;
    readonly position: number | null;
  },
): Promise<{ readonly runId: string } | null> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(discussion)
      .where(eq(discussion.id, input.discussionId))
      .limit(1)
      .for("update");
    if (!row || !OPEN.includes(row.status)) return null;
    await tx
      .insert(run)
      .values({
        id: input.runId,
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        threadId: row.threadId,
        trigger: "discussion",
        triggeredBy: ctx.userId,
        tainted: row.tainted,
      })
      .onConflictDoNothing({ target: run.id });
    await tx
      .insert(discussionTurn)
      .values({
        workspaceId: ctx.workspaceId,
        discussionId: input.discussionId,
        runId: input.runId,
        agentId: input.agentId,
        round: input.round,
        position: input.position,
      })
      .onConflictDoNothing({ target: discussionTurn.runId });
    return { runId: input.runId };
  });
}

/** A discussion's turn runs that haven't ended: running, or waiting their turn. */
export async function activeDiscussionRuns(
  db: Database,
  ctx: TenantContext,
  discussionId: string,
): Promise<string[]> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .select({ id: run.id })
      .from(discussionTurn)
      .innerJoin(run, eq(run.id, discussionTurn.runId))
      .where(
        and(
          eq(discussionTurn.discussionId, discussionId),
          inArray(run.status, ["queued", "running", "waiting"]),
        ),
      ),
  );
  return rows.map((r) => r.id);
}

/** A thread's discussions, newest first, each with its turns in order. */
export async function listDiscussions(
  db: Database,
  ctx: TenantContext,
  threadId: string,
  limit = 20,
): Promise<DiscussionWithTurns[]> {
  return withTenant(db, ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(discussion)
      .where(eq(discussion.threadId, threadId))
      .orderBy(desc(discussion.createdAt))
      .limit(limit);
    if (rows.length === 0) return [];
    const turns = await tx
      .select({
        discussionId: discussionTurn.discussionId,
        runId: discussionTurn.runId,
        agentId: discussionTurn.agentId,
        round: discussionTurn.round,
        position: discussionTurn.position,
        status: run.status,
        messageId: message.id,
      })
      .from(discussionTurn)
      .innerJoin(run, eq(run.id, discussionTurn.runId))
      .leftJoin(
        message,
        and(
          eq(message.runId, discussionTurn.runId),
          eq(message.authorType, "agent"),
          eq(message.authorAgentId, discussionTurn.agentId),
        ),
      )
      .where(
        inArray(
          discussionTurn.discussionId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(discussionTurn.createdAt), asc(discussionTurn.id));
    return rows.map((row) => ({
      ...row,
      turns: turns.filter((t) => t.discussionId === row.id).map(({ discussionId: _d, ...t }) => t),
    }));
  });
}
