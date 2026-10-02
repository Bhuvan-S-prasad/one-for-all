import { type TenantContext } from "@ofa/core";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { message, run, thread, threadMember } from "../schema/index";
import { withTenant, type Tx } from "../tenant";

// Threads, messages and the run a message starts (M2.19).

export type ThreadRow = typeof thread.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
export type RunRow = typeof run.$inferSelect;
export type ThreadMemberRow = { type: "user"; userId: string } | { type: "agent"; agentId: string };

export interface ThreadWithMembers extends ThreadRow {
  readonly members: ThreadMemberRow[];
}

async function membersOf(tx: Tx, threadIds: string[]): Promise<Map<string, ThreadMemberRow[]>> {
  const map = new Map<string, ThreadMemberRow[]>();
  if (threadIds.length === 0) return map;
  const rows = await tx
    .select()
    .from(threadMember)
    .where(inArray(threadMember.threadId, threadIds))
    .orderBy(asc(threadMember.joinedAt));
  for (const row of rows) {
    const list = map.get(row.threadId) ?? [];
    list.push(
      row.memberType === "user"
        ? { type: "user", userId: row.userId ?? "" }
        : { type: "agent", agentId: row.agentId ?? "" },
    );
    map.set(row.threadId, list);
  }
  return map;
}

export async function getThread(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<ThreadWithMembers | null> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx.select().from(thread).where(eq(thread.id, id)).limit(1);
    if (!row) return null;
    return { ...row, members: (await membersOf(tx, [id])).get(id) ?? [] };
  });
}

/**
 * The person's direct thread with an agent, created on first use. Chat with
 * one agent always continues in the same thread.
 */
export async function directThread(
  db: Database,
  ctx: TenantContext,
  agentId: string,
): Promise<ThreadWithMembers> {
  return withTenant(db, ctx, async (tx) => {
    // Serialise creation for this person and agent, so two tabs make one thread.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`direct:${ctx.userId}:${agentId}`}))`,
    );
    const [existing] = await tx
      .select({ id: thread.id })
      .from(thread)
      .innerJoin(threadMember, eq(threadMember.threadId, thread.id))
      .where(
        and(
          eq(thread.kind, "direct"),
          isNull(thread.archivedAt),
          eq(threadMember.agentId, agentId),
          sql`exists (select 1 from ${threadMember} m where m.thread_id = ${thread.id} and m.user_id = ${ctx.userId})`,
        ),
      )
      .orderBy(asc(thread.createdAt))
      .limit(1);
    let id = existing?.id;
    if (!id) {
      const [created] = await tx
        .insert(thread)
        .values({ workspaceId: ctx.workspaceId, kind: "direct", createdBy: ctx.userId })
        .returning({ id: thread.id });
      if (!created) throw new Error("thread insert returned no row");
      id = created.id;
      await tx.insert(threadMember).values([
        { workspaceId: ctx.workspaceId, threadId: id, memberType: "user", userId: ctx.userId },
        { workspaceId: ctx.workspaceId, threadId: id, memberType: "agent", agentId },
      ]);
    }
    const [row] = await tx.select().from(thread).where(eq(thread.id, id)).limit(1);
    if (!row) throw new Error("thread vanished");
    return { ...row, members: (await membersOf(tx, [id])).get(id) ?? [] };
  });
}

/** Newest `limit` messages before a cursor message, returned oldest first. */
export async function listMessages(
  db: Database,
  ctx: TenantContext,
  threadId: string,
  options: { limit: number; before?: string },
): Promise<{ items: MessageRow[]; nextCursor: string | null }> {
  return withTenant(db, ctx, async (tx) => {
    let cursor: SQLCursor | undefined;
    if (options.before) {
      const [pivot] = await tx
        .select({ createdAt: message.createdAt, id: message.id })
        .from(message)
        .where(eq(message.id, options.before))
        .limit(1);
      if (pivot) cursor = pivot;
    }
    const rows = await tx
      .select()
      .from(message)
      .where(
        and(
          eq(message.threadId, threadId),
          cursor
            ? or(
                lt(message.createdAt, cursor.createdAt),
                and(eq(message.createdAt, cursor.createdAt), lt(message.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(options.limit + 1);
    const more = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    return { items: page.reverse(), nextCursor: more ? (page[0]?.id ?? null) : null };
  });
}

type SQLCursor = { createdAt: Date; id: string };

/**
 * A person's message to an agent, and the run that will answer it, written
 * together: either both exist or neither does.
 */
export async function startTurn(
  db: Database,
  ctx: TenantContext,
  input: { threadId: string; agentId: string; content: string },
): Promise<{ message: MessageRow; run: RunRow }> {
  return withTenant(db, ctx, async (tx) => {
    const [runRow] = await tx
      .insert(run)
      .values({
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        threadId: input.threadId,
        trigger: "message",
        triggeredBy: ctx.userId,
      })
      .returning();
    if (!runRow) throw new Error("run insert returned no row");
    const [messageRow] = await tx
      .insert(message)
      .values({
        workspaceId: ctx.workspaceId,
        threadId: input.threadId,
        authorType: "user",
        authorUserId: ctx.userId,
        content: input.content,
        runId: runRow.id,
      })
      .returning();
    if (!messageRow) throw new Error("message insert returned no row");
    await tx.update(thread).set({ updatedAt: new Date() }).where(eq(thread.id, input.threadId));
    return { message: messageRow, run: runRow };
  });
}

export async function getMessage(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<MessageRow | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select().from(message).where(eq(message.id, id)).limit(1),
  );
  return row ?? null;
}
