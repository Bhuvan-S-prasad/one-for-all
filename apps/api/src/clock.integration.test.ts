import { randomBytes } from "node:crypto";
import { loadConfig } from "@ofa/config";
import {
  messagePageSchema,
  routineListSchema,
  routineRunsSchema,
  routineSchema,
  runSchema,
  scheduleListSchema,
  scheduleSchema,
  sendMessageResponseSchema,
  threadSchema,
  type MessageReceivedEvent,
  type RunCancelledEvent,
  type ScheduleCancelledEvent,
  type ScheduleCreatedEvent,
} from "@ofa/contracts";
import {
  asId,
  nextCronTime,
  parseCron,
  type RunContext,
  type RunId,
  type TenantContext,
  type ThreadId,
} from "@ofa/core";
import {
  createDatabase,
  getRoutine,
  listRunEvents,
  loadRootEnv,
  updateRoutine,
  withDatabaseName,
} from "@ofa/db";
import { createMemoryEventBus } from "@ofa/events";
import { createScriptedLLM } from "@ofa/harness";
import type { RunDispatcher } from "@ofa/orchestrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

// Interrupts (M5.05), routines (M5.06) and tasks and reminders for later
// (M5.07) against `oneforall_test_api_clock`, through the real API, stores,
// executor and policy. The orchestrator's part (the tick, the sleep) is
// played by calling what its steps call.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("interrupts, routines and things for later (integration)", async () => {
  const base = loadConfig();
  const dbUrl = withDatabaseName(base.database.url, "oneforall_test_api_clock");
  const config = {
    ...base,
    database: {
      ...base.database,
      url: dbUrl,
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api_clock"),
    },
    vault: { ...base.vault, source: "env" as const, key: randomBytes(32).toString("base64") },
  };
  const started: MessageReceivedEvent[] = [];
  const cancelled: RunCancelledEvent[] = [];
  const waits: ScheduleCreatedEvent[] = [];
  const unwaits: ScheduleCancelledEvent[] = [];
  const dispatcher: RunDispatcher = {
    messageReceived: async (event) => void started.push(event),
    cancelRun: async (event) => void cancelled.push(event),
    approvalDecided: async () => {},
    scheduleCreated: async (event) => void waits.push(event),
    consolidateMemory: async () => {},
    discussionStarted: async () => {},
    discussionStopped: async () => {},
    scheduleCancelled: async (event) => void unwaits.push(event),
  };
  const container = createContainer(config, {
    logger: createLogger({ level: "fatal", format: "json", write: () => {} }),
    bus: createMemoryEventBus(),
    llm: createScriptedLLM([]),
    dispatcher,
  });
  const app = createApp(container);
  const handle = createDatabase(dbUrl, { max: 1 });
  const db = handle.db;
  afterAll(async () => {
    await container.close();
    await handle.close();
  });

  const origin = new URL(config.server.appUrl).origin;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response | Promise<Response>) => (await res).json();

  let tenant: TenantContext;
  let agentId = "";
  let otherAgentId = "";
  beforeAll(async () => {
    const res = await app.request(`${origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        workspaceName: "Clockwork",
        name: "Riley Owner",
        email: "riley@example.com",
        password: "correct-horse-battery",
      }),
    });
    expect(res.status).toBe(201);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const hatch = async (name: string) => {
      const made = await send("POST", "/api/agents", {
        name,
        spec: {
          job: "Briefings",
          modelTier: "fast",
          voice: "brief",
          avatar: { form: "ghost", eyes: "lids", skin: "dots", color: "lilac", mark: "none" },
        },
        grants: [
          { tool: "remind_me", mode: "auto" },
          { tool: "schedule_task", mode: "auto" },
        ],
      });
      expect(made.status).toBe(201);
      return ((await made.json()) as { id: string }).id;
    };
    agentId = await hatch("Herald");
    otherAgentId = await hatch("Porter");
    // The tenant, from the first run the API hands over.
    const thread = threadSchema.parse(
      await json(send("GET", `/api/agents/${otherAgentId}/thread`)),
    );
    await send("POST", `/api/threads/${thread.id}/messages`, { content: "Hello" });
    const event = started.at(-1)!;
    tenant = { workspaceId: asId(event.workspaceId), userId: asId(event.userId) };
    const zone = await send("PUT", "/api/settings/workspace", { timeZone: "Europe/Paris" });
    expect(await zone.json()).toEqual({ timeZone: "Europe/Paris" });
  });

  // ── Routines (M5.06) ──────────────────────────────────────────────────────

  let routineId = "";
  let routineThreadId = "";

  it("refuses schedules that run too often or never, and unknown zones", async () => {
    const make = (cron: string, timeZone?: string) =>
      send("POST", "/api/routines", {
        agentId,
        name: "Too eager",
        instructions: "Check the news.",
        cron,
        ...(timeZone ? { timeZone } : {}),
      });
    const eager = await make("*/5 * * * *");
    expect(eager.status).toBe(400);
    expect(JSON.stringify(await eager.json())).toContain("at most every 15 minutes");
    expect((await make("0 0 30 2 *")).status).toBe(400);
    // Not a schedule, or not a zone: the request itself is refused.
    expect((await make("0 7 * * mon-fry")).status).toBe(422);
    expect((await make("0 7 * * *", "Mars/Olympus")).status).toBe(422);
  });

  it("makes a routine with its own chat, read in the workspace's zone", async () => {
    const res = await send("POST", "/api/routines", {
      agentId,
      name: "Morning brief",
      instructions: "Summarise what changed overnight.",
      cron: "0 7 * * 1-5",
    });
    expect(res.status).toBe(201);
    const routine = routineSchema.parse(await res.json());
    routineId = routine.id;
    routineThreadId = routine.threadId;
    expect(routine).toMatchObject({
      status: "active",
      timeZone: "Europe/Paris",
      pausedReason: null,
    });
    const expected = nextCronTime(parseCron("0 7 * * 1-5"), new Date(), "Europe/Paris")!;
    expect(routine.nextRunAt).toBe(expected.toISOString());
    const chat = threadSchema.parse(await json(send("GET", `/api/threads/${routine.threadId}`)));
    expect(chat.title).toBe("Morning brief");
    const list = routineListSchema.parse(
      await json(send("GET", `/api/routines?agentId=${agentId}`)),
    );
    expect(list.items.map((r) => r.id)).toEqual([routineId]);
  });

  it("pauses and resumes", async () => {
    const paused = routineSchema.parse(
      await json(send("PATCH", `/api/routines/${routineId}`, { status: "paused" })),
    );
    expect(paused).toMatchObject({ status: "paused", pausedReason: "person", nextRunAt: null });
    const resumed = routineSchema.parse(
      await json(send("PATCH", `/api/routines/${routineId}`, { status: "active" })),
    );
    expect(resumed.status).toBe("active");
    expect(resumed.pausedReason).toBeNull();
    expect(resumed.nextRunAt).not.toBeNull();
  });

  let testRunId = "";

  it("runs a test now, posts its request in the routine's chat, and lists it in history", async () => {
    const res = await send("POST", `/api/routines/${routineId}/run`);
    expect(res.status).toBe(201);
    const run = runSchema.parse(await res.json());
    testRunId = run.id;
    expect(run).toMatchObject({ trigger: "manual", status: "queued", threadId: routineThreadId });
    expect(started.at(-1)).toMatchObject({ runId: run.id, trigger: "manual", agentId });
    const messages = messagePageSchema.parse(
      await json(send("GET", `/api/threads/${routineThreadId}/messages`)),
    );
    expect(messages.items.at(-1)).toMatchObject({
      author: { type: "system" },
      content: "Routine “Morning brief”: Summarise what changed overnight.",
      runId: run.id,
    });
    // One at a time.
    expect((await send("POST", `/api/routines/${routineId}/run`)).status).toBe(409);
    const history = routineRunsSchema.parse(
      await json(send("GET", `/api/routines/${routineId}/runs`)),
    );
    expect(history.items.map((r) => r.id)).toEqual([run.id]);
  });

  it("passes a due time over while its last run is still going, then starts the next", async () => {
    const due = (await getRoutine(db, tenant, routineId))!.nextRunAt!;
    const busy = await container.routines.fire(
      tenant,
      routineId,
      due,
      new Date(due.getTime() + 30_000),
    );
    expect(busy).toEqual({ outcome: "busy", run: null });
    const moved = (await getRoutine(db, tenant, routineId))!.nextRunAt!;
    expect(moved.getTime()).toBeGreaterThan(due.getTime());

    await container.runs.update(tenant, asId<RunId>(testRunId), {
      status: "succeeded",
      endedAt: new Date(),
    });
    // Due a minute ago: the owner's tick finds it, and it starts once.
    const now = new Date();
    const dueAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 60_000);
    await updateRoutine(db, tenant, routineId, { nextRunAt: dueAt });
    const listed = await container.routines.listDue(now);
    expect(listed).toEqual([
      {
        workspaceId: tenant.workspaceId,
        userId: tenant.userId,
        routineId,
        dueAt: dueAt.toISOString(),
      },
    ]);
    const fired = await container.routines.fire(tenant, routineId, dueAt, now);
    expect(fired.outcome).toBe("started");
    expect(fired.run).toMatchObject({ trigger: "routine", agentId, threadId: routineThreadId });
    const again = await container.routines.fire(tenant, routineId, dueAt, now);
    expect(again.outcome).toBe("gone");
    const history = routineRunsSchema.parse(
      await json(send("GET", `/api/routines/${routineId}/runs`)),
    );
    expect(history.items.map((r) => r.trigger)).toEqual(["routine", "manual"]);
    const after = (await getRoutine(db, tenant, routineId))!;
    expect(after.lastRunAt).not.toBeNull();
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    await container.runs.update(tenant, asId<RunId>(fired.run!.runId), {
      status: "succeeded",
      endedAt: new Date(),
    });
  });

  it("skips a time missed while the server was off", async () => {
    const now = new Date();
    const dueAt = new Date(now.getTime() - 2 * 60 * 60_000);
    await updateRoutine(db, tenant, routineId, { nextRunAt: dueAt });
    expect((await container.routines.fire(tenant, routineId, dueAt, now)).outcome).toBe("missed");
  });

  it("pauses itself when its owner has been away for weeks", async () => {
    const later = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await updateRoutine(db, tenant, routineId, { nextRunAt: later });
    const fired = await container.routines.fire(tenant, routineId, later, later);
    expect(fired.outcome).toBe("paused");
    const routine = routineSchema.parse(await json(send("GET", `/api/routines/${routineId}`)));
    expect(routine).toMatchObject({ status: "paused", pausedReason: "inactive", nextRunAt: null });
    // Resuming counts as being back.
    await send("PATCH", `/api/routines/${routineId}`, { status: "active" });
  });

  // ── Interrupts (M5.05) ────────────────────────────────────────────────────

  it("sets an agent's routine aside when a person writes to it elsewhere", async () => {
    const dueAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    await updateRoutine(db, tenant, routineId, { nextRunAt: dueAt });
    const fired = await container.routines.fire(tenant, routineId, dueAt, new Date());
    expect(fired.outcome).toBe("started");
    const routineRun = fired.run!.runId;
    await container.runs.update(tenant, asId<RunId>(routineRun), { status: "running" });

    const chat = threadSchema.parse(await json(send("GET", `/api/agents/${agentId}/thread`)));
    const posted = await send("POST", `/api/threads/${chat.id}/messages`, {
      content: "Quick question",
    });
    expect(posted.status).toBe(201);
    expect(cancelled.find((c) => c.runId === routineRun)).toMatchObject({ reason: "preempted" });
  });

  it('"stop now" stops the work in the chat and starts nothing new', async () => {
    const chat = threadSchema.parse(await json(send("GET", `/api/agents/${agentId}/thread`)));
    const before = started.length;
    const res = await send("POST", `/api/threads/${chat.id}/messages`, { content: "Stop now!" });
    expect(res.status).toBe(201);
    const body = sendMessageResponseSchema.parse(await res.json());
    expect(body.run).toBeNull();
    expect(body.message.content).toBe("Stop now!");
    expect(started.length).toBe(before);
    const stops = cancelled.filter((c) => c.reason === "stopped");
    expect(stops.length).toBeGreaterThan(0);
    // With nothing running, "stop" is an ordinary message.
    for (const c of stops) {
      await container.runs.update(tenant, asId<RunId>(c.runId), {
        status: "cancelled",
        onlyIfActive: true,
      });
    }
    const plain = sendMessageResponseSchema.parse(
      await json(send("POST", `/api/threads/${chat.id}/messages`, { content: "stop" })),
    );
    expect(plain.run).not.toBeNull();
    await container.runs.update(tenant, asId<RunId>(plain.run!.id), { status: "cancelled" });
  });

  it("hands a follow-up to the run already working in that chat (steering)", async () => {
    const chat = threadSchema.parse(await json(send("GET", `/api/agents/${otherAgentId}/thread`)));
    const first = sendMessageResponseSchema.parse(
      await json(
        send("POST", `/api/threads/${chat.id}/messages`, { content: "Research pgvector" }),
      ),
    );
    await container.runs.update(tenant, asId<RunId>(first.run!.id), { status: "running" });
    const second = sendMessageResponseSchema.parse(
      await json(send("POST", `/api/threads/${chat.id}/messages`, { content: "Only 0.9, please" })),
    );
    const ctx: RunContext = { ...tenant, agentId: asId(otherAgentId), runId: asId(first.run!.id) };
    const claimed = await container.runs.claimFollowUps!(ctx, asId<ThreadId>(chat.id));
    expect(claimed).toEqual([{ id: second.message.id, content: "Only 0.9, please" }]);
    const steered = await container.runs.get(tenant, asId<RunId>(second.run!.id));
    expect(steered?.status).toBe("cancelled");
    const events = await listRunEvents(db, tenant, second.run!.id);
    expect(events.at(-1)).toMatchObject({ type: "run.ended", payload: { stopReason: "steered" } });
    expect(await container.runs.claimFollowUps!(ctx, asId<ThreadId>(chat.id))).toEqual([]);
    await container.runs.update(tenant, asId<RunId>(first.run!.id), { status: "succeeded" });
  });

  // ── Tasks and reminders for later (M5.07) ─────────────────────────────────

  /** A run of the agent in its chat, for its tools to run in. */
  async function runIn(content: string): Promise<{ ctx: RunContext; threadId: string }> {
    const chat = threadSchema.parse(await json(send("GET", `/api/agents/${agentId}/thread`)));
    const turn = sendMessageResponseSchema.parse(
      await json(send("POST", `/api/threads/${chat.id}/messages`, { content })),
    );
    return {
      ctx: { ...tenant, agentId: asId(agentId), runId: asId(turn.run!.id) },
      threadId: chat.id,
    };
  }
  const call = (ctx: RunContext, name: string, args: unknown, step = "tool-0-0") =>
    container.harness.tools.execute(
      { name, args, toolCallId: step, idempotencyKey: `${ctx.runId}:${step}`, tainted: false },
      ctx,
    );

  it("sets a reminder once, waits for it, and posts it when due", async () => {
    const { ctx, threadId } = await runIn("Remind me to stretch in half an hour");
    const outcome = await call(ctx, "remind_me", { in_minutes: 30, message: "Time to stretch" });
    expect(outcome).toMatchObject({
      status: "ok",
      content: expect.stringContaining("(Europe/Paris)"),
    });
    // A retried call returns what the first one did and sets nothing more.
    await call(ctx, "remind_me", { in_minutes: 30, message: "Time to stretch" });
    const pending = scheduleListSchema.parse(
      await json(send("GET", `/api/schedules?agentId=${agentId}&status=pending`)),
    );
    expect(pending.items).toHaveLength(1);
    const item = pending.items[0]!;
    expect(item).toMatchObject({ kind: "reminder", content: "Time to stretch", threadId });
    expect(waits.at(-1)).toMatchObject({ scheduleId: item.id, dueAt: item.dueAt });

    expect(await container.scheduler.fire(tenant, item.id, new Date())).toEqual({
      outcome: "reminded",
      run: null,
    });
    const messages = messagePageSchema.parse(
      await json(send("GET", `/api/threads/${threadId}/messages`)),
    );
    expect(messages.items.at(-1)).toMatchObject({
      author: { type: "agent", agentId },
      content: "Reminder: Time to stretch",
    });
    // Fired once.
    expect((await container.scheduler.fire(tenant, item.id, new Date())).outcome).toBe("cancelled");
  });

  it("wakes the agent for a task, tainted if the run that set it was", async () => {
    const { ctx, threadId } = await runIn("Check the pricing page tonight");
    await container.runs.update(tenant, ctx.runId, { tainted: true });
    const outcome = await call(ctx, "schedule_task", {
      at: `${new Date().getUTCFullYear() + 1}-01-15 21:00`,
      task: "Check whether the pricing page changed since this morning.",
    });
    expect(outcome).toMatchObject({ status: "ok" });
    const item = scheduleListSchema
      .parse(await json(send("GET", `/api/schedules?agentId=${agentId}&status=pending`)))
      .items.find((s) => s.kind === "task")!;
    expect(item.dueAt).toBe(`${new Date().getUTCFullYear() + 1}-01-15T20:00:00.000Z`);
    const fired = await container.scheduler.fire(tenant, item.id, new Date());
    expect(fired.outcome).toBe("started");
    expect(fired.run).toMatchObject({ trigger: "schedule", agentId, threadId });
    const run = await container.runs.get(tenant, asId<RunId>(fired.run!.runId));
    expect(run).toMatchObject({ trigger: "schedule", tainted: true, status: "queued" });
    const messages = messagePageSchema.parse(
      await json(send("GET", `/api/threads/${threadId}/messages`)),
    );
    expect(messages.items.at(-1)).toMatchObject({
      author: { type: "system" },
      content: "Scheduled task: Check whether the pricing page changed since this morning.",
      runId: fired.run!.runId,
    });
  });

  it("cancels a pending item, which then never fires", async () => {
    const { ctx } = await runIn("Remind me about the call tomorrow");
    await call(ctx, "remind_me", { in_minutes: 24 * 60, message: "The call" });
    const item = scheduleListSchema
      .parse(await json(send("GET", `/api/schedules?agentId=${agentId}&status=pending`)))
      .items.find((s) => s.content === "The call")!;
    const res = await send("DELETE", `/api/schedules/${item.id}`);
    expect(scheduleSchema.parse(await res.json()).status).toBe("cancelled");
    expect(unwaits.at(-1)).toMatchObject({ scheduleId: item.id });
    expect((await container.scheduler.fire(tenant, item.id, new Date())).outcome).toBe("cancelled");
    expect((await send("DELETE", `/api/schedules/${item.id}`)).status).toBe(409);
  });
});
