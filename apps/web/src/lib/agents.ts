import { moodFor, useRuns } from "@ofa/client";
import type { Agent, FamiliarMood, Run } from "@ofa/contracts";

/** Starter prompts for an agent, from its job and tools (an empty chat, Home's Ask box). */
export function starters(agent: Agent): string[] {
  const tools = new Set(agent.grants.filter((g) => g.mode !== "blocked").map((g) => g.tool));
  const list: string[] = [];
  if (tools.has("web.search")) list.push("Find the latest on something for me, with sources");
  if (tools.has("web.read_url")) list.push("Summarise a page: paste the link here");
  if (tools.has("remember")) list.push("Remember that I prefer short answers");
  list.push("What can you help me with?");
  return list.slice(0, 3);
}

/**
 * "@scout compare two tools" → Scout and "compare two tools". Matches an
 * agent's slug or name (any case); null when the text names no agent.
 */
export function parseMention(
  text: string,
  agents: readonly Agent[],
): { agent: Agent; rest: string } | null {
  const match = /^\s*@([\p{L}\p{N}_-]+)\s*/u.exec(text);
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  const agent = agents.find((a) => a.slug.toLowerCase() === name || a.name.toLowerCase() === name);
  return agent ? { agent, rest: text.slice(match[0].length) } : null;
}

/** Sentences for each mood, as in the design (status is never colour alone). */
export const MOOD_SENTENCES: Record<FamiliarMood, string> = {
  idle: "Ready when you are",
  thinking: "Thinking it over",
  working: "Working on something",
  waiting: "Waiting for a turn with the model",
  asleep: "Asleep",
  error: "Something went wrong",
};

/** Latest run per agent, from the workspace's recent runs. */
export function latestRunsByAgent(runs: readonly Run[] | undefined): Map<string, Run> {
  const map = new Map<string, Run>();
  for (const run of runs ?? []) {
    const known = map.get(run.agentId);
    if (!known || run.createdAt > known.createdAt) map.set(run.agentId, run);
  }
  return map;
}

/** Each agent's current mood, from its latest run. */
export function useAgentMoods(
  agents: readonly Agent[] | undefined,
): Map<string, { mood: FamiliarMood; run?: Run }> {
  const { data: runs } = useRuns();
  const latest = latestRunsByAgent(runs);
  const map = new Map<string, { mood: FamiliarMood; run?: Run }>();
  for (const agent of agents ?? []) {
    const run = latest.get(agent.id);
    map.set(agent.id, { mood: moodFor({ agentStatus: agent.status, run }), run });
  }
  return map;
}

export const BUSY_MOODS: ReadonlySet<FamiliarMood> = new Set(["thinking", "working", "waiting"]);

/**
 * Whether a familiar should move (UX.06): when it is busy, stuck, or the one
 * on screen. Everything else holds still so lists stay calm.
 */
export function shouldAnimate(mood: FamiliarMood, onScreen = false): boolean {
  return onScreen || BUSY_MOODS.has(mood) || mood === "error";
}

/** One word for the sidebar and lists; idle says nothing. */
export const MOOD_WORDS: Partial<Record<FamiliarMood, string>> = {
  thinking: "Working",
  working: "Working",
  waiting: "Waiting",
  error: "Stuck",
  asleep: "Asleep",
};

export const TIER_INFO = {
  fast: { label: "Fast", hint: "Quick replies, simple lookups." },
  standard: { label: "Standard", hint: "Most jobs. A good default." },
  strong: { label: "Strong", hint: "Harder, multi-step work. Slower." },
} as const;

/**
 * Built-in tools an agent can be granted. Labels are written for people; the
 * server checks every call against the grant (hard rule 5). `starter` tools
 * are on for a new agent; the computer is opt-in (M3).
 */
export const BUILTIN_TOOLS = [
  { name: "web.search", label: "Search the web", hint: "Find pages about a topic.", starter: true },
  {
    name: "web.read_url",
    label: "Read web pages",
    hint: "Open a page and read it.",
    starter: true,
  },
  {
    name: "remember",
    label: "Remember facts",
    hint: "Save preferences and facts for next time.",
    starter: true,
  },
  {
    name: "recall",
    label: "Recall memories",
    hint: "Look up what it saved before.",
    starter: true,
  },
  {
    name: "todo.write",
    label: "Keep a checklist",
    hint: "Plan longer tasks step by step.",
    starter: true,
  },
  {
    name: "browser.*",
    label: "Use a browser",
    hint: "Open sites, click and fill in forms in its own browser, with its own logins.",
    starter: false,
  },
  {
    name: "use_saved_login",
    label: "Sign in with saved logins",
    hint: "Types a login you saved in Settings into that site. It never sees the password.",
    starter: false,
  },
  {
    name: "shell.run",
    label: "Run commands",
    hint: "A Linux shell on its computer, with Python and git.",
    starter: false,
  },
  {
    name: "files.*",
    label: "Work with files",
    hint: "Read and write files on its computer, shared with your other agents.",
    starter: false,
  },
  {
    name: "delegate_task",
    label: "Hand work to other agents",
    hint: "Give another of your agents a task and use its answer. That agent works with its own tools and permissions.",
    starter: false,
  },
  {
    name: "message_agent",
    label: "Message other agents",
    hint: "Pass a request to another agent in the chat. Its reply appears in the chat later. Lets a group's coordinator route messages.",
    starter: false,
  },
] as const;
