import { randomBytes } from "node:crypto";
import { loadConfig } from "@ofa/config";
import {
  discussionListSchema,
  sendMessageResponseSchema,
  threadSchema,
  type DiscussionStartedEvent,
  type DiscussionStoppedEvent,
  type MessageReceivedEvent,
} from "@ofa/contracts";
import {
  asId,
  type AgentId,
  type LLMRequest,
  type RunContext,
  type TenantContext,
  type ThreadId,
} from "@ofa/core";
import { createDatabase, loadRootEnv, schema, withDatabaseName, withTenant } from "@ofa/db";
import { createMemoryEventBus } from "@ofa/events";
import {
  createMemoStepRunner,
  createScriptedLLM,
  runAgent,
  runDiscussion,
  type ScriptedReply,
} from "@ofa/harness";
import type { RunDispatcher } from "@ofa/orchestrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

// Group discussions end to end (ADR-0050) against `oneforall_test_api_discussion`:
// "@all" opens one, the turns run in order through the real harness, stores
// and threads, the coordinator closes, and "stop" ends one at once. Inngest's
// `discussion-run` is played by `runDiscussion` with a step runner that runs
// each turn as `agent-run` would.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

const last = (request: LLMRequest) => request.messages.at(-1)?.content ?? "";

const tenantOf = (event: { workspaceId: string; userId: string }): TenantContext => ({
  workspaceId: asId(event.workspaceId),
  userId: asId(event.userId),
});

/** Plays every agent, by its name and the turn it is asked for. */
const agents: ScriptedReply = (request) => {
  const system = request.messages[0]?.content ?? "";
  const asked = last(request);
  const tools = (request.tools ?? []).map((t) => t.name);
  if (system.includes("Your name is Lead")) {
    if (asked.includes("close it with one agreed answer")) {
      return { text: "Postgres: Ana's point on familiarity, Ben's on pgvector." };
    }
    // Answering the person: asks the group when it can.
    const answered = request.messages.some((m) => m.role === "tool");
    if (tools.includes("ask_group") && !answered) {
      return {
        toolCalls: [
          {
            id: "g",
            name: "ask_group",
            args: { question: "Which queue should we use, and why?", order: ["ben", "ana"] },
          },
        ],
      };
    }
    return { text: "The group is discussing it." };
  }
  if (asked.includes("round 2 of")) return { text: "NOTHING_TO_ADD" };
  if (system.includes("Your name is Ana")) return { text: "Postgres: we know it well." };
  return { text: "Agree with Ana; pgvector covers search." };
};

describe.skipIf(!hasDb)("group discussions (integration)", async () => {
  const base = loadConfig();
  const dbUrl = withDatabaseName(base.database.url, "oneforall_test_api_discussion");
  const config = {
    ...base,
    database: {
      ...base.database,
      url: dbUrl,
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api_discussion"),
    },
    vault: { ...base.vault, source: "env" as const, key: randomBytes(32).toString("base64") },
  };
  const llm = createScriptedLLM(Array.from({ length: 40 }, () => agents));
  const started: MessageReceivedEvent[] = [];
  const opened: DiscussionStartedEvent[] = [];
  const stopped: DiscussionStoppedEvent[] = [];
  const cancelled: string[] = [];
  const dispatcher: RunDispatcher = {
    messageReceived: async (event) => void started.push(event),
    cancelRun: async (event) => void cancelled.push(event.runId),
    approvalDecided: async () => {},
    scheduleCreated: async () => {},
    scheduleCancelled: async () => {},
    consolidateMemory: async () => {},
    discussionStarted: async (event) => void opened.push(event),
    discussionStopped: async (event) => void stopped.push(event),
  };
  const container = createContainer(config, {
    logger: createLogger({ level: "fatal", format: "json", write: () => {} }),
    bus: createMemoryEventBus(),
    llm,
    dispatcher,
  });
  const app = createApp(container);
  const db = createDatabase(dbUrl, { max: 1 });
  afterAll(async () => {
    await container.close();
    await db.close();
  });

  const origin = new URL(config.server.appUrl).origin;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const hatch = async (name: string, grants: { tool: string; mode: string }[]) => {
    const res = await send("POST", "/api/agents", {
      name,
      spec: {
        job: name,
        modelTier: "fast",
        voice: "brief",
        avatar: { form: "ghost", eyes: "lids", skin: "dots", color: "lilac", mark: "none" },
      },
      grants,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const post = async (content: string) => {
    const res = await send("POST", `/api/threads/${groupId}/messages`, { content });
    expect(res.status).toBe(201);
    return sendMessageResponseSchema.parse(await res.json());
  };
  const discussions = async () =>
    discussionListSchema.parse(
      await (await send("GET", `/api/threads/${groupId}/discussions`)).json(),
    ).items;
  /** What `discussion-run` does: each turn run as `agent-run` would, in order. */
  const runIt = (event: DiscussionStartedEvent, order: string[] = []) => {
    const tenant = tenantOf(event);
    return runDiscussion(
      { ctx: tenant, discussionId: event.discussionId },
      { discussions: container.discussions },
      createMemoStepRunner({
        onInvoke: async (_id, child) => {
          order.push(child.agentId);
          return runAgent(
            {
              ctx: { ...tenant, agentId: child.agentId, runId: child.runId },
              threadId: child.threadId,
              trigger: "discussion",
              requestId: child.messageId,
              ...(child.discussion ? { discussion: child.discussion } : {}),
            },
            container.harness,
            createMemoStepRunner(),
          );
        },
      }),
    );
  };

  let leadId = "";
  let anaId = "";
  let benId = "";
  let groupId = "";
  beforeAll(async () => {
    const res = await app.request(`${origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        workspaceName: "Team HQ",
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
    leadId = await hatch("Lead", [
      { tool: "ask_group", mode: "auto" },
      { tool: "message_agent", mode: "auto" },
    ]);
    anaId = await hatch("Ana", [{ tool: "message_agent", mode: "auto" }]);
    benId = await hatch("Ben", []);
    const group = await send("POST", "/api/threads", {
      agentIds: [leadId, anaId, benId],
      coordinatorAgentId: leadId,
      title: "Stack",
    });
    groupId = threadSchema.parse(await group.json()).id;
  });

  it("opens a discussion for @all, with everyone but the coordinator in roster order", async () => {
    const sent = await post("@all Which database should we use for the new service?");
    expect(sent.run).toBeNull();
    expect(started).toHaveLength(0);
    expect(opened).toHaveLength(1);
    const [d] = await discussions();
    expect(d).toMatchObject({
      id: opened[0]!.discussionId,
      questionMessageId: sent.message.id,
      coordinatorAgentId: leadId,
      memberIds: [anaId, benId],
      rounds: 2,
      round: 1,
      status: "active",
      turns: [],
    });
  });

  it("runs the turns in order, ends the rounds when everyone passes, and closes", async () => {
    const order: string[] = [];
    const result = await runIt(opened[0]!, order);
    expect(result).toMatchObject({ status: "done", turns: 4, rounds: 2 });
    expect(order).toEqual([anaId, benId, anaId, benId, leadId]);

    const [d] = await discussions();
    expect(d!.status).toBe("done");
    expect(d!.endedAt).not.toBeNull();
    expect(d!.turns.map((t) => [t.agentId, t.round, t.position, t.status])).toEqual([
      [anaId, 1, 0, "succeeded"],
      [benId, 1, 1, "succeeded"],
      [anaId, 2, 0, "succeeded"],
      [benId, 2, 1, "succeeded"],
      [leadId, 2, null, "succeeded"],
    ]);
    // Passes posted nothing; the close is the pinned answer.
    expect(d!.turns.map((t) => t.messageId !== null)).toEqual([true, true, false, false, true]);
    expect(d!.closingMessageId).toBe(d!.turns.at(-1)!.messageId);
    const messages = (
      await withTenant(db.db, tenantOf(opened[0]!), (tx) => tx.select().from(schema.message))
    ).filter((m) => m.threadId === groupId);
    expect(messages.at(-1)?.content).toContain("Ana's point on familiarity");
    // Each turn is a discussion run in the thread.
    const runs = (
      await withTenant(db.db, tenantOf(opened[0]!), (tx) => tx.select().from(schema.run))
    ).filter((r) => r.threadId === groupId);
    expect(runs.every((r) => r.trigger === "discussion")).toBe(true);
    // A turn run brings nobody in: no contacts, no members, nobody to ask.
    const ana: RunContext = {
      ...tenantOf(opened[0]!),
      agentId: asId<AgentId>(anaId),
      runId: asId(d!.turns[0]!.runId),
    };
    expect(await container.harness.team!.contacts(ana)).toEqual([]);
    expect(await container.harness.team!.members(ana)).toEqual([]);
    expect(await container.harness.team!.discussants!(ana)).toEqual([]);
  });

  it("makes one run per turn, and none once the discussion is over", async () => {
    const event = opened[0]!;
    const turn = { round: 1, position: 0, agentId: asId<AgentId>(anaId) };
    expect(
      await container.discussions.startTurn(tenantOf(event), event.discussionId, turn),
    ).toBeNull();
  });

  it("reads the person's messages into the next turn, and stops at once on stop", async () => {
    await post("/discuss @ben and @ana: which cache?");
    expect(opened).toHaveLength(2);
    const [d] = await discussions();
    expect(d).toMatchObject({ memberIds: [benId, anaId], status: "active" });
    // Another message joins it without a run of its own.
    const joined = await post("Keep the cost low, please.");
    expect(joined.run).toBeNull();
    expect(started).toHaveLength(0);
    // A second discussion can't open while this one is going on.
    const again = await post("@all and another thing");
    expect(again.run).toBeNull();
    expect(opened).toHaveLength(2);

    // Ben's turn is waiting to start when the person says stop.
    const waiting = await container.discussions.startTurn(tenantOf(opened[1]!), d!.id, {
      round: 1,
      position: 0,
      agentId: asId<AgentId>(benId),
    });
    const stop = await post("stop");
    expect(stop.run).toBeNull();
    expect(stopped.map((s) => s.discussionId)).toEqual([d!.id]);
    expect((await discussions())[0]!.status).toBe("stopped");
    expect(cancelled).toContain(waiting!.runId);
    // Nothing runs once it is stopped.
    const result = await runIt(opened[1]!);
    expect(result.status).toBe("skipped");
  });

  it("stops the whole discussion when one turn's run is stopped", async () => {
    await post("@all one more: which logger?");
    const event = opened.at(-1)!;
    const turn = await container.discussions.startTurn(tenantOf(event), event.discussionId, {
      round: 1,
      position: 0,
      agentId: asId<AgentId>(anaId),
    });
    const res = await send("POST", `/api/runs/${turn!.runId}/stop`);
    expect(res.status).toBe(202);
    expect(stopped.at(-1)?.discussionId).toBe(event.discussionId);
    expect((await discussions())[0]!.status).toBe("stopped");
    // The next member's turn is never made.
    expect(
      await container.discussions.startTurn(tenantOf(event), event.discussionId, {
        round: 1,
        position: 1,
        agentId: asId<AgentId>(benId),
      }),
    ).toBeNull();
  });

  it("lets the coordinator ask the group with ask_group, in the order it names", async () => {
    const sent = await post("What do you both think about queues?");
    expect(sent.run?.agentId).toBe(leadId);
    const event = started.at(-1)!;
    const lead: RunContext = {
      workspaceId: asId(event.workspaceId),
      userId: asId(event.userId),
      agentId: asId(leadId),
      runId: asId(event.runId),
    };
    // It may ask Ana and Ben, by their cards.
    expect((await container.harness.team!.discussants!(lead)).map((m) => m.slug)).toEqual([
      "ana",
      "ben",
    ]);
    const result = await runAgent(
      {
        ctx: lead,
        threadId: asId<ThreadId>(groupId),
        trigger: "message",
        requestId: event.messageId,
      },
      container.harness,
      createMemoStepRunner(),
    );
    expect(result).toMatchObject({ status: "succeeded", stopReason: "final_answer" });
    expect(opened).toHaveLength(4);
    const [d] = await discussions();
    expect(d).toMatchObject({ memberIds: [benId, anaId], status: "active", rounds: 2 });
    // The question is posted by the coordinator, and its own reply follows.
    const messages = (
      await withTenant(db.db, lead, (tx) => tx.select().from(schema.message))
    ).filter((m) => m.threadId === groupId);
    const question = messages.find((m) => m.id === d!.questionMessageId)!;
    expect(question).toMatchObject({
      authorAgentId: leadId,
      content: "Which queue should we use, and why?",
    });
    expect(messages.at(-1)?.content).toBe("The group is discussing it.");
    // While it is open, members aren't messaged outside their turns.
    await expect(
      container.harness.team!.message(lead, {
        key: "m1",
        agent: "ana",
        content: "Quick question for you here.",
      }),
    ).rejects.toThrow(/in a discussion/);
    const order: string[] = [];
    expect((await runIt(opened[3]!, order)).status).toBe("done");
    expect(order).toEqual([benId, anaId, benId, anaId, leadId]);
  });
});
