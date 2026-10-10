import {
  LEARN_EVENT_PREFIX,
  type AgentProfile,
  type LLMGateway,
  type MemoryScope,
  type MemoryStore,
  type RunContext,
  type RunEventWrite,
} from "@ofa/core";
import type { HistoryMessage } from "./context";
import { modelCallEvents } from "./events";
import { isPlaceholder, lastJsonObject } from "./json";
import { MEMORY_EXTRACTION, promptRef } from "./prompts";
import { truncateToTokens } from "./tokens";

// Post-run fact extraction (ARCHITECTURE.md §8): after an answered run, a fast
// model picks out durable facts. Facts from a tainted run are stored
// unverified and are not preloaded until a person confirms them. Its events
// carry the `learn-` key prefix, the only ones a closed run log accepts.

const MAX_FACTS = 5;

export interface ExtractionInput {
  readonly llm: LLMGateway;
  readonly memory: MemoryStore;
  readonly ctx: RunContext;
  readonly agent: AgentProfile;
  readonly history: readonly HistoryMessage[];
  readonly answer: string;
  readonly verified: boolean;
  /** Where the exchange happened, for its episode. */
  readonly threadId: string | null;
  readonly log: (events: RunEventWrite[]) => Promise<void>;
}

/** Whose a fact is (M5.09): the person's, the whole team's, or the agent's own work. */
export type FactAbout = "person" | "team" | "work";

export interface Extraction {
  /** One sentence on what was asked and how it ended; empty if the model gave none. */
  readonly episode: string;
  readonly facts: readonly { readonly text: string; readonly about: FactAbout }[];
}

/** Whose a fact is, however the model spelled it ("Team", "workspace", "user"). */
function aboutOf(value: unknown): FactAbout {
  const v = typeof value === "string" ? value.trim().toLowerCase().replace(/^the /, "") : "";
  if (["person", "user", "people", "me", "personal"].includes(v)) return "person";
  if (["team", "workspace", "company", "organisation", "organization", "everyone"].includes(v)) {
    return "team";
  }
  return "work";
}

/**
 * Read `{"episode": "...", "facts": [{"text", "about"}]}`. Plain strings in
 * `facts` (the first version's shape) count as the agent's own.
 */
export function parseExtraction(text: string): Extraction {
  const parsed = lastJsonObject(text, ["facts", "episode"]);
  const said = typeof parsed?.episode === "string" ? parsed.episode.trim() : "";
  const episode = said.length >= 10 && !isPlaceholder(said) ? said.slice(0, 500) : "";
  const raw = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const facts = raw
    .map((f): { text: string; about: FactAbout } | null => {
      if (typeof f === "string") return { text: f.trim(), about: "work" };
      if (!f || typeof f !== "object") return null;
      const { text: t, about } = f as { text?: unknown; about?: unknown };
      if (typeof t !== "string") return null;
      return {
        text: t.trim(),
        about: aboutOf(about),
      };
    })
    .filter((f): f is { text: string; about: FactAbout } => !!f)
    .filter((f) => f.text.length >= 8 && f.text.length <= 300 && !isPlaceholder(f.text))
    .slice(0, MAX_FACTS);
  return { episode, facts };
}

/** The facts' texts alone. */
export function parseFacts(text: string): string[] {
  return parseExtraction(text).facts.map((f) => f.text);
}

/**
 * Where a fact goes (§8 scopes): the person's own details to the agent's
 * private notes about them, team knowledge to the workspace, the rest to the
 * agent's own memory; each only if the agent may use that scope, else its
 * own memory, else the first scope it has.
 */
export function scopeFor(agent: AgentProfile, about: FactAbout): MemoryScope | null {
  const wanted: MemoryScope =
    about === "person" ? "agent_user" : about === "team" ? "workspace" : "agent";
  if (agent.memoryScopes.includes(wanted)) return wanted;
  if (agent.memoryScopes.includes("agent")) return "agent";
  return agent.memoryScopes[0] ?? null;
}

export async function extractMemories(input: ExtractionInput) {
  const userTurns = input.history.filter((m) => m.author === "user");
  if (input.agent.memoryScopes.length === 0 || userTurns.length === 0) {
    return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
  }
  const transcript = truncateToTokens(
    [
      ...input.history
        .slice(-6)
        .map((m) => `${m.author === "user" ? "Person" : "Agent"}: ${m.content}`),
      `Agent: ${input.answer}`,
    ].join("\n"),
    3_000,
  );
  const response = await input.llm.generate(
    {
      tier: "fast",
      messages: [{ role: "user", content: MEMORY_EXTRACTION.render({ transcript }) }],
      // The JSON itself is short, but reasoning models think aloud first:
      // 400 cut them off before any JSON (session 8), and 1,500 did when the
      // exchange was long (M5.09 live check).
      maxOutputTokens: 3_000,
      temperature: 0,
      promptVersion: promptRef(MEMORY_EXTRACTION),
    },
    input.ctx,
  );

  const events: RunEventWrite[] = modelCallEvents(
    `${LEARN_EVENT_PREFIX}model`,
    "fast",
    response,
    promptRef(MEMORY_EXTRACTION),
  );
  const extraction = parseExtraction(response.text);
  if (extraction.episode && input.memory.writeEpisode) {
    // A better summary of this run than the one written as it ended (M5.09).
    await input.memory.writeEpisode(input.ctx, {
      threadId: input.threadId,
      summary: extraction.episode,
      outcome: "done",
      tainted: !input.verified,
    });
  }
  for (const [n, fact] of extraction.facts.entries()) {
    const scope = scopeFor(input.agent, fact.about)!;
    const record = await input.memory.write(input.ctx, {
      scope,
      kind: "fact",
      content: fact.text,
      verified: input.verified,
    });
    events.push({
      key: `${LEARN_EVENT_PREFIX}memory-${n}`,
      type: "memory.written",
      payload: { memoryId: record.id, scope, verified: record.verified },
    });
  }
  await input.log(events);
  return { ...response.usage, calls: 1 };
}
