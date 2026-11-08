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

/** Addresses the whole group (ADR-0050): `@all`, `@everyone`, `@team`, `@group`. */
const WHOLE_GROUP = /(^|[^\p{L}\p{N}._-])@(all|everyone|team|group)(?![\p{L}\p{N}_-])/iu;
/** A message that opens with `/discuss`. */
const DISCUSS = /^\s*\/discuss(?![\p{L}\p{N}_-])/iu;

/**
 * A message that asks the whole group starts a discussion (ADR-0050). Who
 * takes part, in order: the members it `@mentions` when it names two or
 * more, else every active member but the coordinator, in roster order.
 * Null when the message doesn't ask the group.
 */
export function discussionFor(
  content: string,
  members: readonly GroupMember[],
  coordinatorId: string | null,
): { members: GroupMember[] } | null {
  if (!WHOLE_GROUP.test(content) && !DISCUSS.test(content)) return null;
  const active = members.filter((m) => m.status === "active");
  const named = active
    .map((member) => ({ member, at: mentionAt(content, member) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((m) => m.member);
  if (named.length >= 2) return { members: named };
  return { members: active.filter((m) => m.id !== coordinatorId) };
}
