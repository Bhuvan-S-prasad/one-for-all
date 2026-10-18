import type { AgentId, MessageId, RunId, ThreadId } from "../ids";
import type { RunContext } from "../tenant";
import type { AgentCapability } from "./runtime";

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
  /** What it can do, from its grants (ADR-0044); absent where nobody worked it out. */
  readonly capabilities?: readonly AgentCapability[];
}

/** The line that opens the roster in `delegate_task`'s description. */
export const ROSTER_HEADING = "Agents you can hand work to (pick each by what it can do):";

/**
 * Members most related to a request first (ADR-0044), so the ones that
 * matter keep full cards when a large team is cut to one line each. Ties keep
 * their order.
 */
export function rankByRequest(members: readonly TeamMember[], request: string): TeamMember[] {
  const words = new Set(
    request
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );
  if (words.size === 0) return [...members];
  const score = (m: TeamMember) => {
    const about = [
      m.name,
      m.job,
      ...(m.capabilities ?? []).flatMap((c) => [c.area, ...c.abilities]),
    ]
      .join(" ")
      .toLowerCase();
    let hits = 0;
    for (const word of words) if (about.includes(word)) hits += 1;
    return hits;
  };
  return members
    .map((m, i) => ({ m, i, s: score(m) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ m }) => m);
}

/** About 1,000 tokens of cards at the 32k window; agents past that get one line (ADR-0044). */
export const ROSTER_CARD_CHARS = 4_000;

/**
 * A team as the model reads it (ADR-0044): each agent's handle, name and job,
 * and a `can:` line from its grants. Full cards until the roster is long,
 * then one line each, so a large team still fits.
 */
export function rosterText(members: readonly TeamMember[], maxChars = ROSTER_CARD_CHARS): string {
  let used = 0;
  return members
    .map((m) => {
      const head = `- ${m.slug} (${m.name}): ${m.job}`;
      if (!m.capabilities) return head;
      const can = m.capabilities.length
        ? m.capabilities.map((c) => `${c.area}: ${c.abilities.join(", ")}`).join("; ")
        : "no tools; answers from what it knows";
      const card = `${head}\n  can: ${can}`;
      if (used + card.length > maxChars) return head;
      used += card.length;
      return card;
    })
    .join("\n");
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

/** A message one agent posted to another, and the run that will answer it (M5.03). */
export interface AgentMessage {
  readonly runId: RunId;
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
  /**
   * The agents this run may message (M5.03): in a group thread its other
   * members, in a direct thread any other active agent. Empty for a run that
   * was itself started by another agent, so messages go one hop.
   */
  contacts(ctx: RunContext): Promise<TeamMember[]>;
  /**
   * Post a message from this run's agent into its thread and wake the agent
   * it names with a run of its own there; that run's reply lands in the same
   * thread, later. Taint carries over as for a handoff. The same `key` posts
   * once.
   */
  message(
    ctx: RunContext,
    input: { readonly key: string; readonly agent: string; readonly content: string },
  ): Promise<AgentMessage>;
}

/** The member a model named, by handle or by name, ignoring case and a leading `@`. */
export function findMember(members: readonly TeamMember[], name: string): TeamMember | undefined {
  const wanted = name.trim().replace(/^@/, "").toLowerCase();
  return members.find((m) => m.slug.toLowerCase() === wanted || m.name.toLowerCase() === wanted);
}
