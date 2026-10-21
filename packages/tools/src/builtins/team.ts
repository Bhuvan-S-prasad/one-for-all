import { findMember, ROSTER_HEADING, rosterText, type TeamDirectory } from "@ofa/core";
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

export const ASK_GROUP = "ask_group";

const ASK_GROUP_DESCRIPTION =
  "Ask the whole group a question and let them discuss it (ADR-0050): the members answer one at a time, in order, each reading the answers before it, for one to three rounds, and then you close with one agreed answer. Use it when the person wants the team's views (\"what do you all think\", a choice with trade-offs), not for work one agent can do. After calling it, end your turn with one short line saying the group is discussing it; don't answer the question yourself yet.";

/** A group discussion, asked for by the group's coordinator (ADR-0050). */
export function askGroupTool(team: TeamDirectory | null) {
  return defineTool({
    name: ASK_GROUP,
    description: ASK_GROUP_DESCRIPTION,
    input: z.object({
      question: z
        .string()
        .trim()
        .min(10, "Write the question the group should discuss")
        .max(2_000)
        .describe("The question, with what the members need to know to answer it"),
      order: z
        .array(z.string().trim().min(1).max(80))
        .min(2)
        .max(6)
        .optional()
        .describe("Handles of the members to ask, in the order they answer; everyone if left out"),
      rounds: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("How many rounds (default 2): more for a question worth arguing over"),
    }),
    // It starts runs rather than changing anything outside; each member's
    // calls go through policy, and it starts tainted if this run is.
    annotations: { readOnly: false, destructive: false, outbound: false, idempotent: true },
    editable: ["question"],
    async listed(ctx) {
      const members = team?.discussants ? await team.discussants(ctx) : [];
      if (members.length === 0) return null;
      return {
        description: `${ASK_GROUP_DESCRIPTION}\nThe group:\n${rosterText(members)}`,
      };
    },
    async describe({ question }) {
      const start = question.length > 160 ? `${question.slice(0, 159)}…` : question;
      return `Ask the group: “${start}”`;
    },
    async run({ question, order, rounds }, ctx) {
      if (!team?.discuss) {
        throw Object.assign(new Error("Group discussions aren't available on this server."), {
          code: "not_configured",
        });
      }
      const opened = await team.discuss(ctx, {
        key: ctx.idempotencyKey,
        question,
        ...(order ? { order } : {}),
        ...(rounds !== undefined ? { rounds } : {}),
      });
      const who = opened.members.join(", ");
      return {
        content: `Asked the group. ${who} will answer in that order, then you close the discussion with one agreed answer. End your turn now with one short line telling the person the group is discussing it.`,
        untrusted: false,
      };
    },
  });
}

const DESCRIPTION =
  "Hand a self-contained piece of work to another agent and get its result back. The other agent sees only your brief, never this conversation, so put in everything it needs: the goal, the facts and links to use, and what to send back. Several handoffs in one step run at the same time. To pass on what an earlier handoff in this task found, name that agent in include_results_from: its answer is added to the brief in full. Never write “see the previous response”: the other agent can't see it.";

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
        .max(
          4_000,
          "The brief is over 4,000 characters. Don't paste findings or content into it: name the agents in include_results_from and say what to write",
        )
        .describe("The work, with everything the other agent needs to do it"),
      include_results_from: z
        .array(z.string().trim().min(1).max(80))
        .max(5)
        .optional()
        .describe(
          'Handles of agents whose answers earlier in this task to add to the brief in full, e.g. ["researcher"]',
        ),
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
        description: `${DESCRIPTION}\n${ROSTER_HEADING}\n${rosterText(members)}`,
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
