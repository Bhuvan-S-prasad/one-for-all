import { moodFor, useRuns } from "@ofa/client";
import type { Agent, FamiliarMood, Run } from "@ofa/contracts";

/** A short, stable tag for an agent's familiar, e.g. `FAM-0412`. */
export function serialFor(seed: string): string {
  let hash = 7;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 9973;
  return `FAM-${String(hash).padStart(4, "0")}`;
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
 * Built-in tools an agent can be granted in M2. Labels are written for people;
 * the server checks every call against the grant (hard rule 5).
 */
export const BUILTIN_TOOLS = [
  { name: "web.search", label: "Search the web", hint: "Find pages about a topic." },
  { name: "web.read_url", label: "Read web pages", hint: "Open a page and read it." },
  { name: "remember", label: "Remember facts", hint: "Save preferences and facts for next time." },
  { name: "recall", label: "Recall memories", hint: "Look up what it saved before." },
  { name: "todo.write", label: "Keep a checklist", hint: "Plan longer tasks step by step." },
] as const;
