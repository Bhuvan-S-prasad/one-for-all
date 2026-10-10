import type { AgentId, MessageId, RunId, ThreadId } from "../ids";
import type { RunContext } from "../tenant";

// Agents working as a team (ARCHITECTURE.md §6.3, M5.01). A run hands a piece
// of work to another agent as a child run: the child starts from a brief,
// never the parent's transcript, and its result comes back to the parent.

/** Another agent a run can hand work to. */
export interface TeamMember {
  readonly id: AgentId;
  /** The handle the model names it by, e.g. `researcher`. */
  readonly slug: string;
  readonly name: string;
  readonly job: string;
}

/** A child run made for a handoff, ready to run and be waited on. */
export interface Handoff {
  readonly runId: RunId;
  /** The handoff's own thread: the brief, then the child's reply. */
  readonly threadId: ThreadId;
  /** The brief, as the thread's first message. */
  readonly messageId: MessageId;
  readonly agentId: AgentId;
  readonly agentName: string;
}

export interface TeamDirectory {
  /**
   * The agents this run may hand work to: active ones other than its own.
   * Empty for a run that is itself a handoff: delegation goes one level
   * deep, so agents can't hand work around in a circle.
   */
  members(ctx: RunContext): Promise<TeamMember[]>;
  /**
   * Make the child run for a handoff: its thread, the brief as the first
   * message, and a queued run that remembers its parent and starts tainted if
   * the parent was (ADR-0013). The same `key` returns the same handoff, so a
   * retried step never starts a second child.
   */
  handoff(
    ctx: RunContext,
    input: { readonly key: string; readonly agent: string; readonly brief: string },
  ): Promise<Handoff>;
}

/** The member a model named, by handle or by name, ignoring case and a leading `@`. */
export function findMember(members: readonly TeamMember[], name: string): TeamMember | undefined {
  const wanted = name.trim().replace(/^@/, "").toLowerCase();
  return members.find((m) => m.slug.toLowerCase() === wanted || m.name.toLowerCase() === wanted);
}
