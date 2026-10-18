import { randomBytes } from "node:crypto";
import { loadConfig } from "@ofa/config";
import {
  runSchema,
  sendMessageResponseSchema,
  threadListSchema,
  threadSchema,
  type MessageReceivedEvent,
} from "@ofa/contracts";
import {
  asId,
  type AgentId,
  type ChildRunResult,
  type RunContext,
  type RunId,
  type ThreadId,
} from "@ofa/core";
import { createDatabase, loadRootEnv, schema, withDatabaseName, withTenant } from "@ofa/db";
import { createMemoryEventBus } from "@ofa/events";
import {
  createMemoStepRunner,
  createScriptedLLM,
  runAgent,
  type ScriptedReply,
} from "@ofa/harness";
import type { RunDispatcher } from "@ofa/orchestrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";
import { createTeamDirectory, stableUuid } from "./services/team";

// M5.01 and M5.02 end to end against `oneforall_test_api_team`: a coordinator
// hands two pieces of work to two specialists at once, through the real
// executor, policy, Postgres stores and threads. Inngest's `step.invoke` is
// played by running each child with the same harness, as `agent-run` would.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

/** Plays every agent: what each one says depends on who it is and what it has seen. */
const team: ScriptedReply = (request) => {
  const system = request.messages[0]?.content ?? "";
  const toolResults = request.messages.filter((m) => m.role === "tool");
  // The group's coordinator (M5.04): passes the question to the researcher.
  if (system.includes("Your name is Lead")) {
    if (toolResults.length === 0) {
      return {
        toolCalls: [
          {
            id: "m",
            name: "message_agent",
            args: { agent: "researcher", message: "Please find when pgvector 0.9 was released." },
          },
        ],
      };
    }
    return { text: "I've asked Researcher; the answer will follow here." };
  }
  if (system.includes("Your name is Coordinator")) {
    if (toolResults.length === 0) {
      return {
        toolCalls: [
          {
            id: "a",
            name: "delegate_task",
            args: {
              agent: "researcher",
              brief: "Find when pgvector 0.9 was released, with a source.",
            },
          },
          {
            id: "b",
            name: "delegate_task",
            args: {
              agent: "Writer",
              brief: "Write one friendly sentence announcing a database upgrade.",
            },
          },
        ],
      };
    }
    return { text: `Combined: ${toolResults.map((m) => m.content).join(" | ")}` };
  }
  if (system.includes("Your name is Researcher")) return { text: "Released on 2026-09-12." };
  return { text: "Our database just got faster!" };
};

describe.skipIf(!hasDb)("handing work to other agents (integration)", async () => {
  const base = loadConfig();
  const dbUrl = withDatabaseName(base.database.url, "oneforall_test_api_team");
  const config = {
    ...base,
    database: {
      ...base.database,
      url: dbUrl,
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api_team"),
    },
    vault: { ...base.vault, source: "env" as const, key: randomBytes(32).toString("base64") },
  };
  const llm = createScriptedLLM(Array.from({ length: 30 }, () => team));
  const started: MessageReceivedEvent[] = [];
  const dispatcher: RunDispatcher = {
    messageReceived: async (event) => void started.push(event),
    cancelRun: async () => {},
    approvalDecided: async () => {},
    scheduleCreated: async () => {},
    consolidateMemory: async () => {},
    scheduleCancelled: async () => {},
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
        job: name === "Coordinator" ? "Routing" : name,
        modelTier: "fast",
        voice: "brief",
        avatar: { form: "ghost", eyes: "lids", skin: "dots", color: "lilac", mark: "none" },
      },
      grants,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  let coordinatorId = "";
  let researcherId = "";
  let writerId = "";
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
    coordinatorId = await hatch("Coordinator", [{ tool: "delegate_task", mode: "auto" }]);
    // The researcher may hand work on too, but a handed-over run can't (one level).
    researcherId = await hatch("Researcher", [{ tool: "delegate_task", mode: "auto" }]);
    writerId = await hatch("Writer", []);
  });

  let parent: RunContext;

  it("hands two jobs to two agents at once and answers with both results", async () => {
    const thread = threadSchema.parse(
      await (await send("GET", `/api/agents/${coordinatorId}/thread`)).json(),
    );
    const posted = await send("POST", `/api/threads/${thread.id}/messages`, {
      content: "Find the pgvector 0.9 release date and draft an announcement.",
    });
    const { run } = sendMessageResponseSchema.parse(await posted.json());
    const event = started.at(-1)!;
    parent = {
      workspaceId: asId(event.workspaceId),
      userId: asId(event.userId),
      agentId: asId(coordinatorId),
      runId: asId(run!.id),
    };

    // What `agent-run` does when invoked: run the child with the same harness.
    const children: string[] = [];
    const steps = createMemoStepRunner({
      onInvoke: async (_id, child): Promise<ChildRunResult> => {
        children.push(child.agentId);
        const result = await runAgent(
          {
            ctx: { ...parent, agentId: child.agentId, runId: child.runId },
            threadId: child.threadId,
            trigger: "delegation",
          },
          container.harness,
          createMemoStepRunner(),
        );
        return result;
      },
    });
    const result = await runAgent(
      { ctx: parent, threadId: asId<ThreadId>(thread.id), trigger: "message" },
      container.harness,
      steps,
    );
    expect(result).toMatchObject({ status: "succeeded", stopReason: "final_answer" });
    expect(children.sort()).toEqual([researcherId, writerId].sort());

    // The coordinator saw the roster (not itself); a handed-over run saw no delegate_task.
    const coordinatorTools = llm.requests[0]?.tools ?? [];
    const delegate = coordinatorTools.find((t) => t.name === "delegate_task");
    // Each with a capability card from its grants (ADR-0044): neither has work tools here.
    expect(delegate?.description).toContain(
      "- researcher (Researcher): Researcher\n  can: no tools; answers from what it knows",
    );
    expect(delegate?.description).toContain(
      "- writer (Writer): Writer\n  can: no tools; answers from what it knows",
    );
    expect(delegate?.description).not.toContain("coordinator");
    const researcherCall = llm.requests.find((r) =>
      r.messages[0]?.content.includes("Your name is Researcher"),
    );
    expect(researcherCall?.messages[0]?.content).toContain(
      "Another agent in this workspace handed you this task.",
    );
    expect((researcherCall?.tools ?? []).map((t) => t.name)).not.toContain("delegate_task");

    // Both answers came back into the coordinator's reply.
    const messages = (
      await withTenant(db.db, parent, (tx) => tx.select().from(schema.message))
    ).filter((m) => m.threadId === thread.id);
    const reply = messages.find((m) => m.authorType === "agent")?.content ?? "";
    expect(reply).toContain(
      '"agent":"Researcher","status":"done","answer":"Released on 2026-09-12."',
    );
    expect(reply).toContain(
      '"agent":"Writer","status":"done","answer":"Our database just got faster!"',
    );
  });

  it("keeps each handoff as its own thread and child run, visible in Activity", async () => {
    const runs = (await withTenant(db.db, parent, (tx) => tx.select().from(schema.run))).filter(
      (r) => r.parentRunId === parent.runId,
    );
    expect(runs).toHaveLength(2);
    for (const child of runs) {
      expect(child).toMatchObject({ trigger: "delegation", status: "succeeded", tainted: false });
      const thread = (
        await withTenant(db.db, parent, (tx) => tx.select().from(schema.thread))
      ).find((t) => t.id === child.threadId);
      expect(thread?.kind).toBe("handoff");
      const messages = (
        await withTenant(db.db, parent, (tx) => tx.select().from(schema.message))
      ).filter((m) => m.threadId === child.threadId);
      // The brief by the coordinator, then the child's own reply (not mistaken for one).
      expect(messages.map((m) => m.authorAgentId)).toEqual([coordinatorId, child.agentId]);
    }
    const researcherRun = runs.find((r) => r.agentId === researcherId)!;
    const shown = runSchema.parse(
      await (await send("GET", `/api/runs/${researcherRun.id}`)).json(),
    );
    expect(shown).toMatchObject({
      parentRunId: parent.runId,
      request: "Find when pgvector 0.9 was released, with a source.",
      reply: "Released on 2026-09-12.",
    });
    // The person's own chats with the researcher don't include the handoff.
    const chats = await (await send("GET", `/api/agents/${researcherId}/threads`)).json();
    expect((chats as { items: unknown[] }).items).toEqual([]);
    // Nothing left running for Stop to stop.
    expect(await container.harness.runs.activeChildren?.(parent, parent.runId)).toEqual([]);
  });

  it("makes the same child for the same call, and starts it tainted after outside content", async () => {
    const directory = createTeamDirectory(container.db);
    await container.harness.runs.update(parent, parent.runId, { tainted: true });
    const input = {
      key: `${parent.runId}:tool-9-0`,
      agent: "writer",
      brief: "Draft a short note.",
    };
    const first = await directory.handoff(parent, input);
    const again = await directory.handoff(parent, input);
    expect(again).toEqual(first);
    expect(first.runId).toBe(stableUuid(`${parent.workspaceId}:${input.key}:run`));
    const child = (await withTenant(db.db, parent, (tx) => tx.select().from(schema.run))).find(
      (r) => r.id === first.runId,
    );
    expect(child).toMatchObject({ tainted: true, status: "queued", parentRunId: parent.runId });
    // Queued, so Stop on the coordinator would stop it too.
    expect(await container.harness.runs.activeChildren?.(parent, parent.runId)).toEqual([
      asId<RunId>(first.runId),
    ]);
    // A handed-over run can't hand on: no members, and no handoff.
    const childCtx = { ...parent, agentId: asId<AgentId>(writerId), runId: first.runId };
    expect(await directory.members(childCtx)).toEqual([]);
    await expect(
      directory.handoff(childCtx, {
        key: "x",
        agent: "researcher",
        brief: "Anything at all here.",
      }),
    ).rejects.toThrow(/no other agent/);
    await expect(
      directory.handoff(parent, { key: "y", agent: "Coordinator", brief: "Hand it to yourself." }),
    ).rejects.toThrow(/no agent called Coordinator/);
  });

  // ── Group chats (M5.04) and messages between agents (M5.03) ───────────────

  let leadId = "";
  let groupId = "";

  it("makes a group chat with a coordinator, and refuses one that doesn't add up", async () => {
    leadId = await hatch("Lead", [{ tool: "message_agent", mode: "auto" }]);
    const res = await send("POST", "/api/threads", {
      agentIds: [researcherId, leadId, writerId],
      coordinatorAgentId: leadId,
      title: "Database upgrade",
    });
    expect(res.status).toBe(201);
    const group = threadSchema.parse(await res.json());
    expect(group).toMatchObject({
      kind: "group",
      title: "Database upgrade",
      coordinatorAgentId: leadId,
    });
    // The person, then the coordinator first.
    expect(group.members.map((m) => (m.type === "agent" ? m.agentId : "you"))).toEqual([
      "you",
      leadId,
      researcherId,
      writerId,
    ]);
    groupId = group.id;
    const listed = threadListSchema.parse(await (await send("GET", "/api/threads")).json());
    expect(listed.items.map((t) => t.id)).toEqual([groupId]);

    const outsider = await send("POST", "/api/threads", {
      agentIds: [researcherId, writerId],
      coordinatorAgentId: leadId,
    });
    expect(outsider.status).toBe(422);
    const unknown = await send("POST", "/api/threads", {
      agentIds: [researcherId, "00000000-0000-4000-8000-000000000000"],
    });
    expect(unknown.status).toBe(404);
    // One agent makes a plain chat, kept out of the group list.
    const direct = await send("POST", "/api/threads", { agentIds: [writerId] });
    expect(threadSchema.parse(await direct.json()).kind).toBe("direct");
  });

  it("gives a message to the member it mentions, and anything else to the coordinator", async () => {
    const post = async (content: string) => {
      const res = await send("POST", `/api/threads/${groupId}/messages`, { content });
      expect(res.status).toBe(201);
      return sendMessageResponseSchema.parse(await res.json());
    };
    const mentioned = await post("@Writer draft one line about the upgrade, please.");
    expect(mentioned.run?.agentId).toBe(writerId);
    const routed = await post("When was pgvector 0.9 released?");
    expect(routed.run?.agentId).toBe(leadId);
    expect(started.at(-1)).toMatchObject({ agentId: leadId, trigger: "message" });
  });

  it("the coordinator passes it to a member, whose reply lands in the same chat later", async () => {
    const event = started.at(-1)!;
    const lead: RunContext = {
      workspaceId: asId(event.workspaceId),
      userId: asId(event.userId),
      agentId: asId(leadId),
      runId: asId(event.runId),
    };
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
    const leadCall = llm.requests.find((r) => r.messages[0]?.content.includes("Your name is Lead"));
    const messageTool = leadCall?.tools?.find((t) => t.name === "message_agent");
    // In a group, only its members can be messaged.
    expect(messageTool?.description).toContain("- researcher (Researcher): Researcher");
    expect(messageTool?.description).not.toContain("coordinator (");

    // The message woke the researcher: a run of its own in the group, started by the lead's.
    const woken = started.at(-1)!;
    expect(woken).toMatchObject({
      agentId: researcherId,
      threadId: groupId,
      trigger: "event",
    });
    const wokenRun = (await withTenant(db.db, lead, (tx) => tx.select().from(schema.run))).find(
      (r) => r.id === woken.runId,
    );
    expect(wokenRun).toMatchObject({ trigger: "event", parentRunId: lead.runId, status: "queued" });

    // What `agent-run` does with that event.
    const answered = await runAgent(
      {
        ctx: { ...lead, agentId: asId<AgentId>(researcherId), runId: asId(woken.runId) },
        threadId: asId<ThreadId>(groupId),
        trigger: "event",
        requestId: woken.messageId,
      },
      container.harness,
      createMemoStepRunner(),
    );
    expect(answered).toMatchObject({ status: "succeeded", learn: false });
    const researcherCall = llm.requests.findLast((r) =>
      r.messages[0]?.content.includes("Your name is Researcher"),
    );
    expect(researcherCall?.messages[0]?.content).toContain(
      "Lead, another agent in this conversation, sent you this message.",
    );
    // One hop: a woken run can't message or hand work on.
    const names = (researcherCall?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("message_agent");
    expect(names).not.toContain("delegate_task");

    const messages = (await withTenant(db.db, lead, (tx) => tx.select().from(schema.message)))
      .filter((m) => m.threadId === groupId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const lastThree = messages.slice(-3).map((m) => [m.authorAgentId, m.content]);
    expect(lastThree).toEqual([
      [leadId, "@Researcher Please find when pgvector 0.9 was released."],
      [leadId, "I've asked Researcher; the answer will follow here."],
      [researcherId, "Released on 2026-09-12."],
    ]);
  });

  it("in a direct chat, an agent can message any other agent of the workspace", async () => {
    const thread = threadSchema.parse(
      await (await send("GET", `/api/agents/${leadId}/thread`)).json(),
    );
    await send("POST", `/api/threads/${thread.id}/messages`, { content: "Hello there" });
    const event = started.at(-1)!;
    const ctx: RunContext = {
      workspaceId: asId(event.workspaceId),
      userId: asId(event.userId),
      agentId: asId(leadId),
      runId: asId(event.runId),
    };
    const contacts = await createTeamDirectory(container.db).contacts(ctx);
    expect(contacts.map((c) => c.name).sort()).toEqual(["Coordinator", "Researcher", "Writer"]);
    // Without a way to wake agents, a message is refused rather than left unanswered.
    await expect(
      createTeamDirectory(container.db).message(ctx, {
        key: "k",
        agent: "writer",
        content: "Anything at all.",
      }),
    ).rejects.toThrow(/can't be woken/);
  });
});
