import { type TenantContext } from "@ofa/core";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../client";
import { message, run, thread, threadMember } from "../schema/index";
import { withTenant, type Tx } from "../tenant";
import { likePattern } from "./runs";

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

/** Direct threads between this person and one agent, not archived. */
function directWith(ctx: TenantContext, agentId: string): SQL {
  return and(
    eq(thread.kind, "direct"),
    isNull(thread.archivedAt),
    sql`exists (select 1 from ${threadMember} m where m.thread_id = ${thread.id} and m.agent_id = ${agentId})`,
    sql`exists (select 1 from ${threadMember} m where m.thread_id = ${thread.id} and m.user_id = ${ctx.userId})`,
  )!;
}

async function insertDirectThread(tx: Tx, ctx: TenantContext, agentId: string): Promise<string> {
  const [created] = await tx
    .insert(thread)
    .values({ workspaceId: ctx.workspaceId, kind: "direct", createdBy: ctx.userId })
    .returning({ id: thread.id });
  if (!created) throw new Error("thread insert returned no row");
  await tx.insert(threadMember).values([
    { workspaceId: ctx.workspaceId, threadId: created.id, memberType: "user", userId: ctx.userId },
    { workspaceId: ctx.workspaceId, threadId: created.id, memberType: "agent", agentId },
  ]);
  return created.id;
}

/** Serialise thread creation for this person and agent, so two tabs make one thread. */
async function lockDirect(tx: Tx, ctx: TenantContext, agentId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`direct:${ctx.userId}:${agentId}`}))`,
  );
}

async function withMembers(tx: Tx, id: string): Promise<ThreadWithMembers> {
  const [row] = await tx.select().from(thread).where(eq(thread.id, id)).limit(1);
  if (!row) throw new Error("thread vanished");
  return { ...row, members: (await membersOf(tx, [id])).get(id) ?? [] };
}

/**
 * The person's current direct thread with an agent (the one used most
 * recently), created on first use. "New chat" starts another (UX.13).
 */
export async function directThread(
  db: Database,
  ctx: TenantContext,
  agentId: string,
): Promise<ThreadWithMembers> {
  return withTenant(db, ctx, async (tx) => {
    await lockDirect(tx, ctx, agentId);
    const [existing] = await tx
      .select({ id: thread.id })
      .from(thread)
      .where(directWith(ctx, agentId))
      .orderBy(desc(thread.updatedAt), desc(thread.createdAt))
      .limit(1);
    return withMembers(tx, existing?.id ?? (await insertDirectThread(tx, ctx, agentId)));
  });
}

/**
 * A fresh direct thread with an agent (UX.13). When the current one has no
 * messages yet it is reused, so pressing New chat twice makes one empty chat.
 */
export async function newDirectThread(
  db: Database,
  ctx: TenantContext,
  agentId: string,
): Promise<ThreadWithMembers> {
  return withTenant(db, ctx, async (tx) => {
    await lockDirect(tx, ctx, agentId);
    const [empty] = await tx
      .select({ id: thread.id })
      .from(thread)
      .where(
        and(
          directWith(ctx, agentId),
          sql`not exists (select 1 from ${message} where ${message.threadId} = ${thread.id})`,
        ),
      )
      .orderBy(desc(thread.updatedAt))
      .limit(1);
    if (empty) {
      // Bring it to the top, so it is the current chat.
      await tx.update(thread).set({ updatedAt: new Date() }).where(eq(thread.id, empty.id));
      return withMembers(tx, empty.id);
    }
    return withMembers(tx, await insertDirectThread(tx, ctx, agentId));
  });
}

export interface ThreadSummaryRow extends ThreadWithMembers {
  /** The start of the first message the person wrote. */
  readonly preview: string | null;
  readonly messageCount: number;
  readonly lastMessageAt: Date | null;
}

/**
 * A person's chats with one agent, most recent first (UX.13). `search`
 * matches any message in the chat; `%` and `_` match literally.
 */
export async function listDirectThreads(
  db: Database,
  ctx: TenantContext,
  agentId: string,
  options: { limit: number; before?: string; search?: string; previewChars: number },
): Promise<{ items: ThreadSummaryRow[]; nextCursor: string | null }> {
  return withTenant(db, ctx, async (tx) => {
    let pivot: { updatedAt: Date; id: string } | undefined;
    if (options.before) {
      [pivot] = await tx
        .select({ updatedAt: thread.updatedAt, id: thread.id })
        .from(thread)
        .where(eq(thread.id, options.before))
        .limit(1);
    }
    const rows = await tx
      .select({
        thread,
        preview: sql<string | null>`(select left(${message.content}, ${options.previewChars}) from ${message}
          where ${message.threadId} = ${thread.id} and ${message.authorType} = 'user'
          order by ${message.createdAt} asc limit 1)`,
        messageCount: sql<number>`(select count(*)::int from ${message} where ${message.threadId} = ${thread.id})`,
        lastMessageAt: sql<string | null>`(select max(${message.createdAt}) from ${message} where ${message.threadId} = ${thread.id})`,
      })
      .from(thread)
      .where(
        and(
          directWith(ctx, agentId),
          options.search
            ? sql`exists (select 1 from ${message} where ${message.threadId} = ${thread.id}
                and ${message.content} ilike ${likePattern(options.search)})`
            : undefined,
          pivot
            ? or(
                lt(thread.updatedAt, pivot.updatedAt),
                and(eq(thread.updatedAt, pivot.updatedAt), lt(thread.id, pivot.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(thread.updatedAt), desc(thread.id))
      .limit(options.limit + 1);
    const more = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    const members = await membersOf(
      tx,
      page.map((r) => r.thread.id),
    );
    return {
      items: page.map((r) => ({
        ...r.thread,
        members: members.get(r.thread.id) ?? [],
        preview: r.preview,
        messageCount: Number(r.messageCount),
        lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt) : null,
      })),
      nextCursor: more ? (page.at(-1)?.thread.id ?? null) : null,
    };
  });
}

/** Rename a thread or archive it (and bring it back). */
export async function updateThread(
  db: Database,
  ctx: TenantContext,
  id: string,
  patch: { title?: string | null; archived?: boolean },
): Promise<ThreadWithMembers | null> {
  return withTenant(db, ctx, async (tx) => {
    const set: Partial<typeof thread.$inferInsert> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
    if (Object.keys(set).length > 0) {
      const [row] = await tx
        .update(thread)
        .set(set)
        .where(eq(thread.id, id))
        .returning({ id: thread.id });
      if (!row) return null;
    }
    const [row] = await tx.select({ id: thread.id }).from(thread).where(eq(thread.id, id));
    return row ? withMembers(tx, row.id) : null;
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

/** The person's message that started a run, if a message started it. */
export async function runRequestMessage(
  db: Database,
  ctx: TenantContext,
  runId: string,
): Promise<MessageRow | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(message)
      .where(and(eq(message.runId, runId), eq(message.authorType, "user")))
      .orderBy(asc(message.createdAt))
      .limit(1),
  );
  return row ?? null;
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
