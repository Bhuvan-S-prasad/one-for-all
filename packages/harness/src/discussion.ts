import {
  asId,
  type ChildRunResult,
  type DiscussionPlan,
  type DiscussionStore,
  type DiscussionTurn,
  type MessageId,
  type StepRunner,
  type TenantContext,
} from "@ofa/core";

// A group discussion (ADR-0050): members answer one at a time, in a fixed
// order, for at most a few rounds, and the coordinator closes with one answer.
// Each turn is an agent run of its own, started here and waited on with the
// same `invokeRun` a handoff uses, so the turns never overlap and a replay
// makes no second run. Only this loop starts turns; a turn can't bring in
// another agent.

export interface DiscussionInput {
  readonly ctx: TenantContext;
  readonly discussionId: string;
}

export interface DiscussionDeps {
  readonly discussions: DiscussionStore;
  /** How long one turn may take, approvals included. Default 25 hours, as for a handoff. */
  readonly turnTimeoutMs?: number;
}

export interface DiscussionResult {
  readonly status: "done" | "stopped" | "failed" | "skipped";
  /** Member turns run (passes included), not counting the close. */
  readonly turns: number;
  readonly rounds: number;
  readonly closingMessageId: string | null;
}

const TURN_TIMEOUT_MS = 25 * 60 * 60_000;

export async function runDiscussion(
  input: DiscussionInput,
  deps: DiscussionDeps,
  steps: StepRunner,
): Promise<DiscussionResult> {
  const { ctx, discussionId } = input;
  const { discussions } = deps;
  if (!steps.invokeRun) throw new Error("Discussions need a step runner that can start runs");
  const invoke = steps.invokeRun.bind(steps);
  const timeoutMs = deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;

  const plan = await steps.run("plan", () => discussions.get(ctx, discussionId));
  if (!plan || plan.status !== "active" || plan.members.length === 0) {
    return { status: "skipped", turns: 0, rounds: 0, closingMessageId: null };
  }
  const names = plan.members.map((m) => m.name);
  const turnOf = (round: number, position: number | null): DiscussionTurn => ({
    discussionId,
    round,
    rounds: plan.rounds,
    position,
    members: names,
    coordinator: plan.coordinator.name,
    close: position === null,
  });
  let tainted = plan.tainted;
  let turns = 0;
  let rounds = 0;

  /** One turn: its run is made in a step, then run to the end. Null: the discussion was stopped. */
  const take = async (
    round: number,
    position: number | null,
    agent: DiscussionPlan["coordinator"],
  ): Promise<ChildRunResult | "stopped" | null> => {
    const id = position === null ? "close" : `turn-${round}-${position}`;
    const started = await steps.run(id, () =>
      discussions.startTurn(ctx, discussionId, { round, position, agentId: agent.id }),
    );
    if (!started) return "stopped";
    const result = await invoke(
      `${id}-run`,
      {
        agentId: agent.id,
        runId: started.runId,
        threadId: plan.threadId,
        messageId: asId<MessageId>(plan.questionMessageId),
        discussion: turnOf(round, position),
      },
      { timeoutMs },
    );
    if (result?.status === "cancelled") return "stopped";
    // A turn that read outside content taints every later one (ADR-0013).
    if (result?.tainted && !tainted) {
      tainted = true;
      await steps.run(`${id}-taint`, async () => {
        await discussions.update(ctx, discussionId, { tainted: true });
        return true;
      });
    }
    return result;
  };

  const end = async (status: "done" | "stopped" | "failed", closingMessageId: string | null) => {
    await steps.run("end", async () => {
      await discussions.update(ctx, discussionId, {
        status,
        ...(closingMessageId ? { closingMessageId } : {}),
      });
      return true;
    });
    return { status, turns, rounds, closingMessageId };
  };

  for (let round = 1; round <= plan.rounds; round += 1) {
    if (round > 1) {
      await steps.run(`round-${round}`, async () => {
        await discussions.update(ctx, discussionId, { round });
        return true;
      });
    }
    rounds = round;
    let passes = 0;
    for (const [position, member] of plan.members.entries()) {
      const result = await take(round, position, member);
      if (result === "stopped") return end("stopped", null);
      turns += 1;
      // A member whose turn failed is skipped; its run says why in the chat.
      if (result?.passed) passes += 1;
    }
    // Nobody had anything new: the rounds end early.
    if (passes === plan.members.length) break;
  }

  await steps.run("closing", async () => {
    await discussions.update(ctx, discussionId, { status: "closing" });
    return true;
  });
  const closed = await take(rounds, null, plan.coordinator);
  if (closed === "stopped") return end("stopped", null);
  if (!closed || closed.status !== "succeeded" || !closed.messageId) return end("failed", null);
  return end("done", closed.messageId);
}
