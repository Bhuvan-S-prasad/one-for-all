import type { Agent, Conversation } from "@ofa/contracts";
import { shortTime } from "@/lib/format";

// The sidebar's conversation rows (ADR-0052): what each row says, and which
// pages belong to the workspace rather than to a conversation. Pure, so it is
// tested without a browser.

/** At most one state per row, the most urgent first. */
export type RowState = "action" | "stuck" | "unread" | null;

export function rowState(c: Pick<Conversation, "needsYou" | "stuck" | "unread">): RowState {
  if (c.needsYou > 0) return "action";
  if (c.stuck) return "stuck";
  if (c.unread > 0) return "unread";
  return null;
}

/** "14:05" today, "Yesterday", "Mon" this week, then "12 Oct", then "12 Oct 2025". */
export function rowTime(iso: string, now: Date = new Date()): string {
  const day = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(now) - start(day)) / 86_400_000);
  if (diff <= 0) return shortTime(iso);
  if (diff === 1) return "Yesterday";
  if (diff < 7) return day.toLocaleDateString(undefined, { weekday: "short" });
  return day.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Markdown reduced to the words: no marks, links as their text, one line. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The row's second line: who said what last, or an invitation to start. */
export function rowPreview(
  c: Pick<Conversation, "kind" | "last" | "stuck" | "needsYou">,
  agents: ReadonlyMap<string, Pick<Agent, "name">>,
): string {
  if (!c.last) return c.kind === "group" ? "No messages yet" : "Say hello";
  const text = plainText(c.last.snippet) || "Sent a file";
  if (c.last.author === "user") return `You: ${text}`;
  if (c.kind === "group" && c.last.agentId) {
    const name = agents.get(c.last.agentId)?.name;
    if (name) return `${name}: ${text}`;
  }
  return text;
}

/** A group's name: its title, else its agents' names. */
export function groupName(
  c: Pick<Conversation, "title" | "agentIds">,
  agents: ReadonlyMap<string, Pick<Agent, "name">>,
): string {
  if (c.title) return c.title;
  const names = c.agentIds.map((id) => agents.get(id)?.name ?? "Agent");
  return names.length > 0 ? names.join(", ") : "Group chat";
}

/**
 * Pages about the whole workspace rather than one conversation: on these the
 * sidebar lists the workspace's sections instead of the conversations.
 */
export const WORKSPACE_SECTIONS = [
  { to: "/overview", label: "Overview" },
  { to: "/agents", label: "Agents" },
  { to: "/activity", label: "Activity" },
  { to: "/routines", label: "Routines" },
  { to: "/skills", label: "Skills" },
  { to: "/memory", label: "Memory" },
  { to: "/settings", label: "Settings" },
] as const;

export type WorkspacePath = (typeof WORKSPACE_SECTIONS)[number]["to"];

export function isWorkspacePath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/agents" || path === "/agents/new") return true;
  if (path.startsWith("/agents/")) return false;
  return (
    WORKSPACE_SECTIONS.some((s) => path === s.to || path.startsWith(`${s.to}/`)) ||
    path === "/approvals" ||
    path === "/connections"
  );
}
