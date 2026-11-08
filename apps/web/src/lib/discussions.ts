import type { Discussion, DiscussionTurnRecord, Message } from "@ofa/contracts";

// Group discussions in the chat (ADR-0050): which messages belong to one,
// whose turn it is, and the turns folded away once the coordinator closed it.

export type DiscussionRole = "question" | "turn" | "close";

/** Each discussion message by ID: which discussion, and what it is in it. */
export function discussionRoles(
  discussions: readonly Discussion[],
): Map<string, { discussion: Discussion; role: DiscussionRole }> {
  const roles = new Map<string, { discussion: Discussion; role: DiscussionRole }>();
  for (const discussion of discussions) {
    roles.set(discussion.questionMessageId, { discussion, role: "question" });
    for (const turn of discussion.turns) {
      if (turn.messageId)
        roles.set(turn.messageId, { discussion, role: turn.close ? "close" : "turn" });
    }
  }
  return roles;
}

export function isOpen(discussion: Discussion): boolean {
  return discussion.status === "active" || discussion.status === "closing";
}

const WORKING = new Set<DiscussionTurnRecord["status"]>(["queued", "running", "waiting"]);

export type TurnState = "answered" | "passed" | "speaking" | "skipped" | "waiting";

export interface DiscussionProgress {
  readonly round: number;
  /** The members of the round, in order, and how each one's turn stands. */
  readonly members: readonly { readonly agentId: string; readonly state: TurnState }[];
  /** Who is answering now: a member, the coordinator closing, or nobody. */
  readonly current: string | null;
  readonly closing: "waiting" | "writing" | "done";
}

/** Where a discussion stands: the round, each member's turn in it, and the close. */
export function progressOf(discussion: Discussion): DiscussionProgress {
  const round = discussion.round;
  const inRound = discussion.turns.filter((t) => !t.close && t.round === round);
  const members = discussion.memberIds.map((agentId, position) => {
    const turn = inRound.find((t) => t.position === position);
    let state: TurnState = "waiting";
    if (turn && WORKING.has(turn.status)) state = "speaking";
    else if (turn?.messageId) state = "answered";
    else if (turn?.status === "succeeded") state = "passed";
    else if (turn) state = "skipped";
    return { agentId, state };
  });
  const close = discussion.turns.find((t) => t.close);
  const closing = !close ? "waiting" : WORKING.has(close.status) ? "writing" : "done";
  const current =
    closing === "writing"
      ? discussion.coordinatorAgentId
      : (members.find((m) => m.state === "speaking")?.agentId ?? null);
  return { round, members, current, closing };
}

export type ChatItem =
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "turns"; readonly discussion: Discussion; readonly messages: Message[] };

/**
 * The chat with each ended discussion's turns folded into one item (the
 * question and the closing answer stay out). A message of the person's in
 * between keeps its place, so turns on either side of it fold separately.
 * Open discussions stay unfolded, so their turns show as they come.
 */
export function foldTurns(
  messages: readonly Message[],
  roles: ReadonlyMap<string, { discussion: Discussion; role: DiscussionRole }>,
): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    const role = roles.get(message.id);
    if (role?.role === "turn" && !isOpen(role.discussion)) {
      const previous = items.at(-1);
      if (previous?.kind === "turns" && previous.discussion.id === role.discussion.id) {
        previous.messages.push(message);
      } else {
        items.push({ kind: "turns", discussion: role.discussion, messages: [message] });
      }
      continue;
    }
    items.push({ kind: "message", message });
  }
  return items;
}

/** "4 messages with 2 agents". */
export function foldLabel(messages: readonly Message[]): string {
  const agents = new Set(
    messages.flatMap((m) => (m.author.type === "agent" ? [m.author.agentId] : [])),
  ).size;
  const n = messages.length;
  return `${n} ${n === 1 ? "message" : "messages"} with ${agents} ${agents === 1 ? "agent" : "agents"}`;
}

/** The latest discussion that closed with an answer: the one pinned at the top. */
export function pinnedAnswer(discussions: readonly Discussion[]): Discussion | null {
  return (
    [...discussions]
      .filter((d) => d.status === "done" && d.closingMessageId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}
