import type { AgentStatus, FamiliarMood, Run, RunEvent } from "@ofa/contracts";

// A familiar's mood follows its agent's latest run (M2.25). Moods are always
// shown with a word as well as a face and colour (status is never colour alone).

/** An agent with nothing to do for this long looks asleep. */
const NAP_AFTER_MS = 6 * 60 * 60 * 1000;
/** A failure stays visible this long, then the familiar recovers. */
const ERROR_SHOWS_MS = 30 * 60 * 1000;

export interface MoodInput {
  readonly agentStatus: AgentStatus;
  /** The agent's most recent run, if any. */
  readonly run?: Run | null;
  /** That run's latest event, when known (sharper mood while it runs). */
  readonly lastEvent?: RunEvent | null;
  readonly now?: number;
}

export function moodFor({
  agentStatus,
  run,
  lastEvent,
  now = Date.now(),
}: MoodInput): FamiliarMood {
  if (agentStatus !== "active") return "asleep";
  if (!run) return "idle";
  switch (run.status) {
    case "queued":
      return "thinking";
    case "waiting":
      return "waiting";
    case "running":
      // Between a tool being called and its result, it is busy doing.
      return lastEvent?.type === "tool.called" || lastEvent?.type === "policy.decided"
        ? "working"
        : "thinking";
    case "failed": {
      const ended = run.endedAt ? Date.parse(run.endedAt) : now;
      return now - ended < ERROR_SHOWS_MS ? "error" : "idle";
    }
    default: {
      const ended = run.endedAt ? Date.parse(run.endedAt) : now;
      return now - ended > NAP_AFTER_MS ? "asleep" : "idle";
    }
  }
}

/** Short labels, as in the design. */
export const MOOD_LABELS: Record<FamiliarMood, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting",
  asleep: "Asleep",
  error: "Stuck",
};
