import type { SendMessageResponse } from "@ofa/contracts";
import { AppError, asId, NotFoundError, type RunId, type TenantContext } from "@ofa/core";
import { workspaceEvent } from "@ofa/events";
import { getAgent, listAgents, startTurn, type ThreadWithMembers } from "@ofa/db";
import type { Container } from "../container";
import { toMessage, toRun } from "./mappers";
import { pickResponder } from "./routing";

export type TurnDeps = Pick<Container, "db" | "bus" | "dispatcher" | "runs" | "logger">;

/**
 * The agent that answers a person's message: a direct thread's agent, or in
 * a group the member it `@mentions`, else the coordinator (M5.04).
 */
async function responderFor(
  deps: TurnDeps,
  tenant: TenantContext,
  thread: ThreadWithMembers,
  content: string,
) {
  if (thread.kind === "handoff") {
    throw new AppError("bad_request", "This thread is between agents; write to them in a chat");
  }
  const memberIds = thread.members.flatMap((m) => (m.type === "agent" ? [m.agentId] : []));
  if (memberIds.length === 0)
    throw new AppError("bad_request", "This thread has no agent to answer");
  if (thread.kind === "direct") {
    const agent = await getAgent(deps.db, tenant, memberIds[0]!);
    if (!agent) throw new NotFoundError("Agent");
    return agent;
  }
  const agents = (await listAgents(deps.db, tenant)).filter((a) => memberIds.includes(a.id));
  const picked = pickResponder(content, agents, thread.coordinatorAgentId);
  if (!picked) throw new AppError("bad_request", "This thread has no agent to answer");
  return picked.member as (typeof agents)[number];
}

/**
 * Write to the agent in a thread: store the message and its run, announce the
 * message, and hand the run to the orchestrator (M2.19). Shared by sending a
 * message and trying a run again (UX.12). The API never runs the agent
 * (hard rule 1).
 */
export async function startAgentTurn(
  deps: TurnDeps,
  tenant: TenantContext,
  thread: ThreadWithMembers,
  content: string,
): Promise<SendMessageResponse> {
  const agent = await responderFor(deps, tenant, thread, content);
  if (agent.status !== "active") {
    throw new AppError("conflict", `${agent.name} is ${agent.status}. Resume it to chat.`);
  }

  const turn = await startTurn(deps.db, tenant, {
    threadId: thread.id,
    agentId: agent.id,
    content,
  });
  await deps.bus
    .publish(
      workspaceEvent(tenant.workspaceId, {
        kind: "message.created",
        threadId: thread.id,
        messageId: turn.message.id,
      }),
    )
    .catch(() => {});

  try {
    await deps.dispatcher.messageReceived({
      workspaceId: tenant.workspaceId,
      userId: tenant.userId,
      agentId: agent.id,
      threadId: thread.id,
      messageId: turn.message.id,
      runId: turn.run.id,
      trigger: "message",
    });
  } catch (error) {
    deps.logger.error("could not start run", { error, runId: turn.run.id });
    await deps.runs.update(tenant, asId<RunId>(turn.run.id), {
      status: "failed",
      error: {
        code: "dispatch_failed",
        message: "The job runner (Inngest) could not be reached",
      },
      endedAt: new Date(),
      onlyIfActive: true,
    });
    throw new AppError(
      "internal",
      "Couldn't start the agent: the job runner is not reachable. Is Inngest running?",
    );
  }

  return { message: toMessage(turn.message), run: toRun(turn.run) };
}
