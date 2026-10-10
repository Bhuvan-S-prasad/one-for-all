import { agentSpecSchema } from "@ofa/contracts";
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
import { getRun, listAgents, startHandoff, type Database } from "@ofa/db";
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

export function createTeamDirectory(db: Database): TeamDirectory {
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
  };
  return team;
}
