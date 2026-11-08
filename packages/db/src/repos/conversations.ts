import { type TenantContext } from "@ofa/core";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../client";
import { agent, approval, message, routine, run, thread, threadMember } from "../schema/index";
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

/**
 * Direct threads between this person and one agent, not archived. A
 * routine's own chat (M5.06) is listed with them, but never becomes the
 * person's current chat or a reused empty one (`chatsOnly`).
 */
function directWith(ctx: TenantContext, agentId: string, chatsOnly = false): SQL {
  return and(
    eq(thread.kind, "direct"),
    isNull(thread.archivedAt),
    chatsOnly
      ? sql`not exists (select 1 from ${routine} r where r.thread_id = ${thread}.id)`
      : undefined,
    sql`exists (select 1 from ${threadMember} m where m.thread_id = ${thread}.id and m.agent_id = ${agentId})`,
    sql`exists (select 1 from ${threadMember} m where m.thread_id = ${thread}.id and m.user_id = ${ctx.userId})`,
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
      .where(directWith(ctx, agentId, true))
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
          directWith(ctx, agentId, true),
          sql`not exists (select 1 from ${message} m where m.thread_id = ${thread}.id)`,
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

/**
 * A group thread (M5.04): this person and two to six agents, one of them the
 * coordinator. Members are listed coordinator first.
 */
export async function createGroupThread(
  db: Database,
  ctx: TenantContext,
  input: { agentIds: readonly string[]; coordinatorAgentId: string; title: string | null },
): Promise<ThreadWithMembers> {
  return withTenant(db, ctx, async (tx) => {
    const [created] = await tx
      .insert(thread)
      .values({
        workspaceId: ctx.workspaceId,
        kind: "group",
        title: input.title,
        coordinatorAgentId: input.coordinatorAgentId,
        createdBy: ctx.userId,
      })
      .returning({ id: thread.id });
    if (!created) throw new Error("thread insert returned no row");
    const agents = [
      input.coordinatorAgentId,
      ...input.agentIds.filter((id) => id !== input.coordinatorAgentId),
    ];
    await tx.insert(threadMember).values([
      {
        workspaceId: ctx.workspaceId,
        threadId: created.id,
        memberType: "user",
        userId: ctx.userId,
      },
      ...agents.map((agentId) => ({
        workspaceId: ctx.workspaceId,
        threadId: created.id,
        memberType: "agent" as const,
        agentId,
      })),
    ]);
    return withMembers(tx, created.id);
  });
}

/** This person's group threads, most recently active first. */
export async function listGroupThreads(
  db: Database,
  ctx: TenantContext,
  options: { archived?: boolean } = {},
): Promise<ThreadWithMembers[]> {
  return withTenant(db, ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(thread)
      .where(
        and(
          eq(thread.kind, "group"),
          options.archived ? sql`${thread.archivedAt} is not null` : isNull(thread.archivedAt),
          sql`exists (select 1 from ${threadMember} m where m.thread_id = ${thread}.id and m.user_id = ${ctx.userId})`,
        ),
      )
      .orderBy(desc(thread.updatedAt))
      .limit(100);
    const members = await membersOf(
      tx,
      rows.map((r) => r.id),
    );
    return rows.map((row) => ({ ...row, members: members.get(row.id) ?? [] }));
  });
}

/**
 * One agent's message to another in a thread they share (M5.03), and the
 * queued run that will answer it there. IDs come from the caller, derived
 * from the sending run's tool call, so a retried step posts once.
 */
export async function postAgentMessage(
  db: Database,
  ctx: TenantContext,
  input: {
    threadId: string;
    runId: string;
    parentRunId: string;
    fromAgentId: string;
    toAgentId: string;
    content: string;
    tainted: boolean;
  },
): Promise<{ messageId: string; created: boolean }> {
  return withTenant(db, ctx, async (tx) => {
    const [made] = await tx
      .insert(run)
      .values({
        id: input.runId,
        workspaceId: ctx.workspaceId,
        agentId: input.toAgentId,
        threadId: input.threadId,
        parentRunId: input.parentRunId,
        trigger: "event",
        triggeredBy: ctx.userId,
        tainted: input.tainted,
      })
      .onConflictDoNothing({ target: run.id })
      .returning({ id: run.id });
    if (!made) {
      const [sent] = await tx
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.runId, input.runId), eq(message.authorAgentId, input.fromAgentId)))
        .limit(1);
      if (!sent) throw new Error("agent message vanished");
      return { messageId: sent.id, created: false };
    }
    const [sent] = await tx
      .insert(message)
      .values({
        workspaceId: ctx.workspaceId,
        threadId: input.threadId,
        authorType: "agent",
        authorAgentId: input.fromAgentId,
        content: input.content,
        runId: input.runId,
      })
      .returning({ id: message.id });
    if (!sent) throw new Error("message insert returned no row");
    await tx.update(thread).set({ updatedAt: new Date() }).where(eq(thread.id, input.threadId));
    return { messageId: sent.id, created: true };
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
        // Subqueries name their columns in full: drizzle leaves column names
        // unqualified in single-table selects.
        preview: sql<
          string | null
        >`(select left(m.content, ${options.previewChars}) from ${message} m
          where m.thread_id = ${thread}.id and m.author_type = 'user'
          order by m.created_at asc limit 1)`,
        messageCount: sql<number>`(select count(*)::int from ${message} m where m.thread_id = ${thread}.id)`,
        lastMessageAt: sql<
          string | null
        >`(select max(m.created_at) from ${message} m where m.thread_id = ${thread}.id)`,
      })
      .from(thread)
      .where(
        and(
          directWith(ctx, agentId),
          options.search
            ? sql`exists (select 1 from ${message} m where m.thread_id = ${thread}.id
                and m.content ilike ${likePattern(options.search)})`
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
      // `updated_at` orders chats by last use: renaming or archiving (and Undo)
      // must not make a chat the current one.
      set.updatedAt = sql`${thread.updatedAt}` as unknown as Date;
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

/**
 * A person's message that starts no run: "stop" while agents work (M5.05).
 */
export async function postUserMessage(
  db: Database,
  ctx: TenantContext,
  input: { threadId: string; content: string },
): Promise<MessageRow> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx
      .insert(message)
      .values({
        workspaceId: ctx.workspaceId,
        threadId: input.threadId,
        authorType: "user",
        authorUserId: ctx.userId,
        content: input.content,
      })
      .returning();
    if (!row) throw new Error("message insert returned no row");
    await tx.update(thread).set({ updatedAt: new Date() }).where(eq(thread.id, input.threadId));
    return row;
  });
}

/**
 * A handoff (M5.01): its own thread, the brief as the first message (written
 * by the agent handing the work over), and the queued child run, together.
 * IDs come from the caller, derived from the handing run's tool call, so a
 * retried step finds what it made the first time instead of making another.
 */
export async function startHandoff(
  db: Database,
  ctx: TenantContext,
  input: {
    threadId: string;
    runId: string;
    parentRunId: string;
    fromAgentId: string;
    toAgentId: string;
    brief: string;
    title: string;
    tainted: boolean;
  },
): Promise<{ messageId: string; created: boolean }> {
  return withTenant(db, ctx, async (tx) => {
    const [made] = await tx
      .insert(thread)
      .values({
        id: input.threadId,
        workspaceId: ctx.workspaceId,
        kind: "handoff",
        title: input.title,
        createdBy: ctx.userId,
      })
      .onConflictDoNothing({ target: thread.id })
      .returning({ id: thread.id });
    if (!made) {
      const [brief] = await tx
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.threadId, input.threadId), eq(message.runId, input.runId)))
        .orderBy(asc(message.createdAt))
        .limit(1);
      if (!brief) throw new Error("handoff thread has no brief");
      return { messageId: brief.id, created: false };
    }
    await tx.insert(threadMember).values([
      { workspaceId: ctx.workspaceId, threadId: made.id, memberType: "user", userId: ctx.userId },
      {
        workspaceId: ctx.workspaceId,
        threadId: made.id,
        memberType: "agent",
        agentId: input.fromAgentId,
      },
      {
        workspaceId: ctx.workspaceId,
        threadId: made.id,
        memberType: "agent",
        agentId: input.toAgentId,
      },
    ]);
    await tx.insert(run).values({
      id: input.runId,
      workspaceId: ctx.workspaceId,
      agentId: input.toAgentId,
      threadId: made.id,
      parentRunId: input.parentRunId,
      trigger: "delegation",
      triggeredBy: ctx.userId,
      tainted: input.tainted,
    });
    const [brief] = await tx
      .insert(message)
      .values({
        workspaceId: ctx.workspaceId,
        threadId: made.id,
        authorType: "agent",
        authorAgentId: input.fromAgentId,
        content: input.brief,
        runId: input.runId,
      })
      .returning({ id: message.id });
    if (!brief) throw new Error("message insert returned no row");
    return { messageId: brief.id, created: true };
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

// ── Unread (M5.11) ───────────────────────────────────────────────────────────

/** This person has seen everything in the thread up to now. */
export async function markThreadRead(
  db: Database,
  ctx: TenantContext,
  threadId: string,
): Promise<void> {
  await withTenant(db, ctx, (tx) =>
    tx
      .update(threadMember)
      .set({ lastReadAt: new Date() })
      .where(and(eq(threadMember.threadId, threadId), eq(threadMember.userId, ctx.userId))),
  );
}

export interface UnreadRow {
  readonly threadId: string;
  readonly kind: "direct" | "group" | "handoff";
  readonly agentIds: string[];
  readonly unread: number;
  readonly lastAt: Date;
}

/**
 * Chats with agent messages this person hasn't seen: written after they last
 * read the thread (or joined it). Handoff threads are between agents, and
 * archived chats are put away, so neither counts.
 */
export async function unreadThreads(db: Database, ctx: TenantContext): Promise<UnreadRow[]> {
  return withTenant(db, ctx, async (tx) => {
    const rows = await tx.execute<{
      thread_id: string;
      kind: "direct" | "group" | "handoff";
      unread: number;
      last_at: string;
    }>(sql`
      select t.id as thread_id, t.kind, count(m.id)::int as unread, max(m.created_at) as last_at
      from ${threadMember} me
      join ${thread} t on t.id = me.thread_id
      join ${message} m on m.thread_id = t.id
      where me.user_id = ${ctx.userId}
        and t.kind <> 'handoff'
        and t.archived_at is null
        and m.author_type = 'agent'
        and m.created_at > coalesce(me.last_read_at, me.joined_at)
      group by t.id, t.kind
      order by max(m.created_at) desc
      limit 200`);
    const list = [...rows];
    const members = await membersOf(
      tx,
      list.map((r) => r.thread_id),
    );
    return list.map((r) => ({
      threadId: r.thread_id,
      kind: r.kind,
      agentIds: (members.get(r.thread_id) ?? []).flatMap((m) =>
        m.type === "agent" ? [m.agentId] : [],
      ),
      unread: Number(r.unread),
      lastAt: new Date(r.last_at),
    }));
  });
}

// ── Conversations (ADR-0052) ─────────────────────────────────────────────────

export interface ConversationRow {
  readonly kind: "direct" | "group";
  readonly threadId: string | null;
  readonly agentIds: string[];
  readonly title: string | null;
  readonly last: {
    readonly snippet: string;
    readonly author: "user" | "agent" | "system";
    readonly agentId: string | null;
    readonly at: Date;
  } | null;
  readonly unread: number;
  readonly needsYou: number;
  readonly stuck: boolean;
  readonly activeAt: Date;
}

type RawConversation = {
  kind: "direct" | "group";
  thread_id: string | null;
  agent_id: string | null;
  title: string | null;
  last_snippet: string | null;
  last_author: "user" | "agent" | "system" | null;
  last_agent_id: string | null;
  last_at: string | null;
  unread: number;
  needs_you: number;
  last_run_status: string | null;
  active_at: string;
};

/**
 * The sidebar (ADR-0052): one row per agent that isn't archived (its current
 * chat with this person, the one its chat screen opens, or none yet) and one
 * per group chat this person is in, most recently active first. Requests
 * waiting count across all of an agent's direct chats and its runs outside
 * any chat, so a routine's request still raises its agent's row.
 */
export async function listConversations(
  db: Database,
  ctx: TenantContext,
  options: { snippetChars: number },
): Promise<ConversationRow[]> {
  const n = options.snippetChars;
  return withTenant(db, ctx, async (tx) => {
    // Every direct chat between this person and each agent, used three times below.
    const directOf = (agentCol: SQL, chatsOnly = false) => sql`
      select t.id from ${thread} t
      where t.kind = 'direct' and t.archived_at is null
        ${chatsOnly ? sql`and not exists (select 1 from ${routine} ro where ro.thread_id = t.id)` : sql``}
        and exists (select 1 from ${threadMember} m where m.thread_id = t.id and m.agent_id = ${agentCol})
        and exists (select 1 from ${threadMember} m where m.thread_id = t.id and m.user_id = ${ctx.userId})`;
    const lastMessage = (threadCol: SQL) => sql`
      select left(regexp_replace(m.content, '[[:space:]]+', ' ', 'g'), ${n}) as snippet,
             m.author_type as author, m.author_agent_id as agent_id, m.created_at as at
      from ${message} m where m.thread_id = ${threadCol}
      order by m.created_at desc limit 1`;
    const lastRunStatus = (threadCol: SQL) => sql`
      select r.status from ${run} r
      where r.thread_id = ${threadCol} and r.parent_run_id is null
      order by r.created_at desc limit 1`;
    const unreadIn = (threadIds: SQL) => sql`
      select count(*)::int from ${message} m
      join ${threadMember} me on me.thread_id = m.thread_id and me.user_id = ${ctx.userId}
      where m.thread_id in (${threadIds}) and m.author_type = 'agent'
        and m.created_at > coalesce(me.last_read_at, me.joined_at)`;

    const direct = await tx.execute<RawConversation>(sql`
      select 'direct' as kind, lt.id as thread_id, a.id as agent_id, null as title,
             lm.snippet as last_snippet, lm.author as last_author, lm.agent_id as last_agent_id,
             lm.at as last_at,
             (${unreadIn(sql`lt.id`)}) as unread,
             (select count(*)::int from ${approval} ap join ${run} r on r.id = ap.run_id
              where ap.status = 'pending' and ap.agent_id = a.id
                and (r.thread_id is null or r.thread_id in (${directOf(sql`a.id`)}))) as needs_you,
             (${lastRunStatus(sql`lt.id`)}) as last_run_status,
             coalesce(lm.at, lt.created_at, a.created_at) as active_at
      from ${agent} a
      left join lateral (
        select t.id, t.created_at from ${thread} t
        where t.id in (${directOf(sql`a.id`, true)})
        order by t.updated_at desc, t.created_at desc limit 1
      ) lt on true
      left join lateral (${lastMessage(sql`lt.id`)}) lm on true
      where a.status <> 'archived'`);

    const groups = await tx.execute<RawConversation>(sql`
      select 'group' as kind, t.id as thread_id, null as agent_id, t.title,
             lm.snippet as last_snippet, lm.author as last_author, lm.agent_id as last_agent_id,
             lm.at as last_at,
             (${unreadIn(sql`t.id`)}) as unread,
             (select count(*)::int from ${approval} ap join ${run} r on r.id = ap.run_id
              where ap.status = 'pending' and r.thread_id = t.id) as needs_you,
             (${lastRunStatus(sql`t.id`)}) as last_run_status,
             coalesce(lm.at, t.created_at) as active_at
      from ${thread} t
      left join lateral (${lastMessage(sql`t.id`)}) lm on true
      where t.kind = 'group' and t.archived_at is null
        and exists (select 1 from ${threadMember} m where m.thread_id = t.id and m.user_id = ${ctx.userId})
      order by active_at desc
      limit 100`);

    const groupRows = [...groups];
    const members = await membersOf(
      tx,
      groupRows.flatMap((r) => (r.thread_id ? [r.thread_id] : [])),
    );
    const toRow = (r: RawConversation): ConversationRow => ({
      kind: r.kind,
      threadId: r.thread_id,
      agentIds:
        r.kind === "direct"
          ? r.agent_id
            ? [r.agent_id]
            : []
          : (members.get(r.thread_id ?? "") ?? []).flatMap((m) =>
              m.type === "agent" ? [m.agentId] : [],
            ),
      title: r.title,
      last:
        r.last_at && r.last_author
          ? {
              snippet: r.last_snippet ?? "",
              author: r.last_author,
              agentId: r.last_agent_id,
              at: new Date(r.last_at),
            }
          : null,
      unread: Number(r.unread ?? 0),
      needsYou: Number(r.needs_you ?? 0),
      stuck: r.last_run_status === "failed",
      activeAt: new Date(r.active_at),
    });
    return [...direct, ...groupRows]
      .map(toRow)
      .sort((a, b) => b.activeAt.getTime() - a.activeAt.getTime());
  });
}
