import { agentSpecSchema, type MessageReceivedEvent } from "@ofa/contracts";
import {
  AppError,
  asId,
  findMember,
  type AgentCapability,
  type AgentId,
  type MessageId,
  type RunContext,
  type RunId,
  type TeamDirectory,
  type TeamMember,
  type ThreadId,
} from "@ofa/core";
import {
  getRun,
  getThread,
  listAgents,
  openDiscussionIn,
  postAgentMessage,
  startHandoff,
  type Database,
} from "@ofa/db";
import type { OpenDiscussionInput } from "./discussions";
import { createHash } from "node:crypto";

// The workspace's agents as a team (ARCHITECTURE.md §6.3, M5.01), for the
// harness and the `delegate_task` tool.

/** A fixed namespace for handoff IDs (UUID version 5, RFC 9562). */
const NAMESPACE = Buffer.from("7c3f1a52d6e94b8b9a0e5f2c4d1b8e63", "hex");

/**
 * The same UUID for the same name, every time: a retried step that makes a
 * handoff again finds the run and thread it made the first time.
 */
export function stableUuid(name: string): string {
  const hash = createHash("sha1").update(NAMESPACE).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function title(brief: string): string {
  const flat = brief.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

export interface TeamOptions {
  /** Start the run that answers an agent's message (the orchestrator's `agent/message.received`). */
  readonly wake?: (event: MessageReceivedEvent) => Promise<void>;
  /** Tell open clients a message was posted. */
  readonly announce?: (workspaceId: string, threadId: string, messageId: string) => Promise<void>;
  /** What each agent can do, from its grants (the tool executor's, ADR-0044). */
  readonly capabilities?: (
    ctx: RunContext,
    agentIds: readonly AgentId[],
  ) => Promise<ReadonlyMap<string, readonly AgentCapability[]>>;
  /** Open a group discussion and start it (ADR-0050, `ask_group`). */
  readonly openDiscussion?: (
    ctx: RunContext,
    input: OpenDiscussionInput,
  ) => Promise<{ readonly discussionId: string }>;
}

/** Runs another agent started, or the orchestrator for a discussion turn: they bring nobody in. */
function startedByAnother(run: { parentRunId: string | null; trigger: string } | null): boolean {
  return !!run && (!!run.parentRunId || run.trigger === "discussion");
}

export function createTeamDirectory(db: Database, options: TeamOptions = {}): TeamDirectory {
  /** Each member with its capability card (ADR-0044), worked out in one pass. */
  async function withCards(ctx: RunContext, members: TeamMember[]): Promise<TeamMember[]> {
    if (!options.capabilities || members.length === 0) return members;
    const cards = await options.capabilities(
      ctx,
      members.map((m) => m.id),
    );
    return members.map((m) => ({ ...m, capabilities: cards.get(m.id) ?? [] }));
  }

  const team: TeamDirectory = {
    async members(ctx) {
      // One level deep: a run that is itself a handoff hands nothing on, and
      // neither does a discussion turn (ADR-0050).
      const current = await getRun(db, ctx, ctx.runId);
      if (startedByAnother(current)) return [];
      return withCards(
        ctx,
        (await listAgents(db, ctx))
          .filter((a) => a.status === "active" && a.id !== ctx.agentId)
          .map((a) => ({
            id: asId<AgentId>(a.id),
            slug: a.slug,
            name: a.name,
            job: agentSpecSchema.safeParse(a.spec).data?.job ?? "General",
          })),
      );
    },

    async handoff(ctx, input) {
      const members = await team.members(ctx);
      const member = findMember(members, input.agent);
      if (!member) {
        throw new AppError(
          "not_found",
          members.length
            ? `There is no agent called ${input.agent} to hand work to. You can hand work to: ${members.map((m) => m.slug).join(", ")}.`
            : "There is no other agent you can hand work to here.",
        );
      }
      const parent = await getRun(db, ctx, ctx.runId);
      const runId = stableUuid(`${ctx.workspaceId}:${input.key}:run`);
      const threadId = stableUuid(`${ctx.workspaceId}:${input.key}:thread`);
      const { messageId } = await startHandoff(db, ctx, {
        threadId,
        runId,
        parentRunId: ctx.runId,
        fromAgentId: ctx.agentId,
        toAgentId: member.id,
        brief: input.brief,
        title: title(input.brief),
        // A child of a run that read outside content starts tainted (ADR-0013).
        tainted: parent?.tainted ?? false,
      });
      return {
        runId: asId<RunId>(runId),
        threadId: asId<ThreadId>(threadId),
        messageId: asId<MessageId>(messageId),
        agentId: member.id,
        agentName: member.name,
      };
    },

    async contacts(ctx) {
      // One hop: a run started by another agent messages nobody.
      const current = await getRun(db, ctx, ctx.runId);
      if (!current?.threadId || startedByAnother(current)) return [];
      const thread = await getThread(db, ctx, current.threadId);
      if (!thread || thread.kind === "handoff") return [];
      const inThread = new Set(
        thread.members.flatMap((m) => (m.type === "agent" ? [m.agentId] : [])),
      );
      return withCards(
        ctx,
        (await listAgents(db, ctx))
          .filter((a) => a.status === "active" && a.id !== ctx.agentId)
          // In a group, its members; in a direct chat, any agent of the workspace.
          .filter((a) => thread.kind !== "group" || inThread.has(a.id))
          .map((a) => ({
            id: asId<AgentId>(a.id),
            slug: a.slug,
            name: a.name,
            job: agentSpecSchema.safeParse(a.spec).data?.job ?? "General",
          })),
      );
    },

    async message(ctx, input) {
      const contacts = await team.contacts(ctx);
      const member = findMember(contacts, input.agent);
      if (!member) {
        throw new AppError(
          "not_found",
          contacts.length
            ? `You can't message ${input.agent} here. You can message: ${contacts.map((m) => m.slug).join(", ")}.`
            : "There is no other agent you can message here.",
        );
      }
      if (!options.wake) throw new AppError("internal", "Agents can't be woken on this server");
      const current = await getRun(db, ctx, ctx.runId);
      const threadId = current?.threadId;
      if (!threadId) throw new AppError("bad_request", "This run has no conversation to post in");
      // During a discussion only the orchestrator starts turns (ADR-0050).
      if (await openDiscussionIn(db, ctx, threadId)) {
        throw new AppError(
          "conflict",
          "The group is in a discussion right now; messages to members wait until it closes.",
        );
      }
      const runId = stableUuid(`${ctx.workspaceId}:${input.key}:message`);
      // Addressed in the chat, so everyone sees who it went to (§6.3: handoffs are visible).
      const addressed = input.content.trimStart().startsWith("@")
        ? input.content
        : `@${member.name} ${input.content}`;
      const { messageId, created } = await postAgentMessage(db, ctx, {
        threadId,
        runId,
        parentRunId: ctx.runId,
        fromAgentId: ctx.agentId,
        toAgentId: member.id,
        content: addressed,
        // A message written after outside content wakes a tainted run (ADR-0013).
        tainted: current.tainted,
      });
      if (created) await options.announce?.(ctx.workspaceId, threadId, messageId).catch(() => {});
      // Sent every time: a step retried after posting still wakes it, and
      // Inngest drops a second event for the same run.
      await options.wake({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        agentId: member.id,
        threadId,
        messageId,
        runId,
        trigger: "event",
      });
      return {
        runId: asId<RunId>(runId),
        messageId: asId<MessageId>(messageId),
        agentId: member.id,
        agentName: member.name,
      };
    },

    async discussants(ctx) {
      const lead = await leading(ctx);
      if (!lead) return [];
      return withCards(ctx, lead.members);
    },

    async discuss(ctx, input) {
      const lead = await leading(ctx);
      if (!lead || !options.openDiscussion) {
        throw new AppError(
          "bad_request",
          "Only a group's coordinator, answering the person, can ask the group.",
        );
      }
      // Named members in that order (the coordinator too, if named), else everyone but it.
      let members = lead.members;
      if (input.order?.length) {
        const everyone = [...lead.members, lead.self];
        const picked: TeamMember[] = [];
        for (const name of input.order) {
          const member = findMember(everyone, name);
          if (!member) {
            throw new AppError(
              "not_found",
              `${name} isn't in this group. Its members: ${lead.members.map((m) => m.slug).join(", ")}.`,
            );
          }
          if (!picked.some((p) => p.id === member.id)) picked.push(member);
        }
        members = picked;
      }
      const { discussionId } = await options.openDiscussion(ctx, {
        key: input.key,
        threadId: lead.threadId,
        question: { agentId: ctx.agentId, content: input.question },
        startedByRunId: ctx.runId,
        coordinatorAgentId: ctx.agentId,
        memberIds: members.map((m) => m.id),
        ...(input.rounds !== undefined ? { rounds: input.rounds } : {}),
        // Asked after outside content: every turn starts tainted (ADR-0013).
        tainted: lead.tainted,
      });
      return { discussionId, members: members.map((m) => m.name) };
    },
  };

  /**
   * This run, if it may ask its group (ADR-0050): the coordinator's run for a
   * person's message in a group it leads. Its members in roster order, but
   * itself, and the coordinator as a member, for an order that names it.
   */
  async function leading(ctx: RunContext) {
    const current = await getRun(db, ctx, ctx.runId);
    if (!current?.threadId || current.trigger !== "message") return null;
    const thread = await getThread(db, ctx, current.threadId);
    if (!thread || thread.kind !== "group" || thread.coordinatorAgentId !== ctx.agentId) {
      return null;
    }
    const agents = new Map(
      (await listAgents(db, ctx)).filter((a) => a.status === "active").map((a) => [a.id, a]),
    );
    const asMember = (a: Awaited<ReturnType<typeof listAgents>>[number]): TeamMember => ({
      id: asId<AgentId>(a.id),
      slug: a.slug,
      name: a.name,
      job: agentSpecSchema.safeParse(a.spec).data?.job ?? "General",
    });
    const self = agents.get(ctx.agentId);
    if (!self) return null;
    const members = thread.members
      .flatMap((m) => (m.type === "agent" && m.agentId !== ctx.agentId ? [m.agentId] : []))
      .flatMap((id) => {
        const a = agents.get(id);
        return a ? [asMember(a)] : [];
      });
    return {
      threadId: current.threadId,
      tainted: current.tainted,
      members,
      self: asMember(self),
    };
  }

  return team;
}
