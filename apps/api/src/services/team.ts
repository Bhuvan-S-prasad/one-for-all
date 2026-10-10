import { agentSpecSchema, type MessageReceivedEvent } from "@ofa/contracts";
import {
  AppError,
  asId,
  findMember,
  type AgentId,
  type MessageId,
  type RunId,
  type TeamDirectory,
  type ThreadId,
} from "@ofa/core";
import {
  getRun,
  getThread,
  listAgents,
  postAgentMessage,
  startHandoff,
  type Database,
} from "@ofa/db";
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
}

export function createTeamDirectory(db: Database, options: TeamOptions = {}): TeamDirectory {
  const team: TeamDirectory = {
    async members(ctx) {
      // One level deep: a run that is itself a handoff hands nothing on.
      const current = await getRun(db, ctx, ctx.runId);
      if (current?.parentRunId) return [];
      return (await listAgents(db, ctx))
        .filter((a) => a.status === "active" && a.id !== ctx.agentId)
        .map((a) => ({
          id: asId<AgentId>(a.id),
          slug: a.slug,
          name: a.name,
          job: agentSpecSchema.safeParse(a.spec).data?.job ?? "General",
        }));
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
      if (!current?.threadId || current.parentRunId) return [];
      const thread = await getThread(db, ctx, current.threadId);
      if (!thread || thread.kind === "handoff") return [];
      const inThread = new Set(
        thread.members.flatMap((m) => (m.type === "agent" ? [m.agentId] : [])),
      );
      return (
        (await listAgents(db, ctx))
          .filter((a) => a.status === "active" && a.id !== ctx.agentId)
          // In a group, its members; in a direct chat, any agent of the workspace.
          .filter((a) => thread.kind !== "group" || inThread.has(a.id))
          .map((a) => ({
            id: asId<AgentId>(a.id),
            slug: a.slug,
            name: a.name,
            job: agentSpecSchema.safeParse(a.spec).data?.job ?? "General",
          }))
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
  };
  return team;
}
