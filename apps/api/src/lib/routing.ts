// Who answers a message in a group thread (ARCHITECTURE.md §6.3, M5.04): the
// member it `@mentions` first, or else the coordinator, which may answer
// itself or pass the message on (`message_agent`, `delegate_task`).

export interface GroupMember {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: "active" | "paused" | "archived";
}

/** Where `@name` ends: not inside a longer word (`@researcher2`, an email address). */
const END = /^(?![\p{L}\p{N}_-])/u;

/** The position of the first `@mention` of a member in the text, or -1. */
function mentionAt(content: string, member: GroupMember): number {
  const lower = content.toLowerCase();
  let first = -1;
  for (const handle of [member.slug, member.name]) {
    const needle = `@${handle.toLowerCase()}`;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      // Not part of an address like sam@researcher.example.
      const before = at > 0 ? content[at - 1]! : " ";
      if (/[\p{L}\p{N}._-]/u.test(before)) continue;
      if (!END.test(content.slice(at + needle.length))) continue;
      if (first === -1 || at < first) first = at;
      break;
    }
  }
  return first;
}

/**
 * The member who answers: the first one mentioned, else the coordinator,
 * else the first member. `mentioned` says which rule picked it.
 */
export function pickResponder(
  content: string,
  members: readonly GroupMember[],
  coordinatorId: string | null,
): { member: GroupMember; mentioned: boolean } | null {
  const mentions = members
    .map((member) => ({ member, at: mentionAt(content, member) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (mentions[0]) return { member: mentions[0].member, mentioned: true };
  const coordinator = members.find((m) => m.id === coordinatorId) ?? members[0];
  return coordinator ? { member: coordinator, mentioned: false } : null;
}
