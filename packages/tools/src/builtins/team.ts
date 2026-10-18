import { findMember, rosterText, type TeamDirectory } from "@ofa/core";
import { z } from "zod";
import { defineTool } from "../define";

// Handing work to another agent (ARCHITECTURE.md §6.3, M5.01). This tool only
// checks the call: it goes through the grant and policy like any other, and
// names an agent the run may hand work to. The harness then starts the child
// run and waits for it, in its own durable steps, so several handoffs from one
// step run at the same time (M5.02).

export const DELEGATE_TASK = "delegate_task";
export const MESSAGE_AGENT = "message_agent";

const MESSAGE_DESCRIPTION =
  "Send another agent a message in this conversation, without waiting for an answer. It is woken to work on it with its own tools, and its reply appears in this conversation later, where the person sees it. Use it to pass on a request someone else should handle; use delegate_task instead when you need the result to finish your own answer.";

/** Asynchronous messages between agents (§6.3, M5.03). Unlike a handoff, this tool does the whole job. */
export function messageAgentTool(team: TeamDirectory | null) {
  return defineTool({
    name: MESSAGE_AGENT,
    description: MESSAGE_DESCRIPTION,
    input: z.object({
      agent: z.string().trim().min(1).max(80).describe("The agent's handle, e.g. researcher"),
      message: z
        .string()
        .trim()
        .min(10, "Write a message the other agent can act on")
        .max(4_000)
        .describe("What you want it to do, with what it needs to know"),
    }),
    // It wakes another agent rather than changing anything outside; that
    // agent's calls each go through policy, and it starts tainted if this run is.
    annotations: { readOnly: false, destructive: false, outbound: false, idempotent: true },
    editable: ["message"],
    async listed(ctx) {
      const contacts = team ? await team.contacts(ctx) : [];
      if (contacts.length === 0) return null;
      // Each with what it can do, from its grants (ADR-0044).
      return {
        description: `${MESSAGE_DESCRIPTION}\nAgents you can message here:\n${rosterText(contacts)}`,
      };
    },
    async describe({ agent, message }) {
      const start = message.length > 160 ? `${message.slice(0, 159)}…` : message;
      return `Message ${agent}: “${start}”`;
    },
    async run({ agent, message }, ctx) {
      if (!team) {
        throw Object.assign(new Error("Agents can't message each other on this server."), {
          code: "not_configured",
        });
      }
      const sent = await team.message(ctx, { key: ctx.idempotencyKey, agent, content: message });
      return {
        content: `Sent to ${sent.agentName}. Its reply will appear in this conversation by itself when it is ready; you won't see it in this turn, so don't promise to pass it on.`,
        untrusted: false,
      };
    },
  });
}

const DESCRIPTION =
  "Hand a self-contained piece of work to another agent and get its result back. The other agent sees only your brief, never this conversation, so put in everything it needs: the goal, the facts and links to use, and what to send back. Several handoffs in one step run at the same time.";

export function delegateTaskTool(team: TeamDirectory | null) {
  return defineTool({
    name: DELEGATE_TASK,
    description: DESCRIPTION,
    input: z.object({
      agent: z.string().trim().min(1).max(80).describe("The agent's handle, e.g. researcher"),
      brief: z
        .string()
        .trim()
        .min(20, "Write a brief the other agent can act on alone")
        .max(4_000)
        .describe("The work, with everything the other agent needs to do it"),
    }),
    // It starts work rather than changing anything outside; the child's own
    // calls each go through policy, and a tainted parent's child starts tainted.
    annotations: { readOnly: false, destructive: false, outbound: false, idempotent: true },
    // The brief is what the other agent will act on, so a person asked about
    // it can reword it before approving (ADR-0030).
    editable: ["brief"],
    async listed(ctx) {
      const members = team ? await team.members(ctx) : [];
      if (members.length === 0) return null;
      // Each with what it can do, from its grants (ADR-0044).
      return {
        description: `${DESCRIPTION}\nAgents you can hand work to (pick each by what it can do):\n${rosterText(members)}`,
      };
    },
    async describe({ agent, brief }) {
      const start = brief.length > 160 ? `${brief.slice(0, 159)}…` : brief;
      return `Hand work to ${agent}: “${start}”`;
    },
    async run({ agent }, ctx) {
      const members = team ? await team.members(ctx) : [];
      const member = findMember(members, agent);
      if (!member) {
        throw Object.assign(
          new Error(
            members.length
              ? `There is no agent called ${agent} to hand work to. You can hand work to: ${members.map((m) => m.slug).join(", ")}.`
              : "There is no other agent you can hand work to here.",
          ),
          { code: "unknown_agent" },
        );
      }
      return {
        content: `Handing the work to ${member.name}. Its result comes back here when it is done.`,
        untrusted: false,
      };
    },
  });
}
