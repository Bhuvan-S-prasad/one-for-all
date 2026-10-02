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
  readonly log: (events: RunEventWrite[]) => Promise<void>;
}

/** Pull `{"facts": [...]}` out of a reply that may wrap it in prose or a code fence. */
export function parseFacts(text: string): string[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { facts?: unknown };
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.trim())
      .filter((f) => f.length >= 8 && f.length <= 300)
      .slice(0, MAX_FACTS);
  } catch {
    return [];
  }
}

/** Facts go to the agent's own memory when it has one, else the first scope it may use. */
function scopeFor(agent: AgentProfile): MemoryScope | null {
  if (agent.memoryScopes.includes("agent")) return "agent";
  return agent.memoryScopes[0] ?? null;
}

export async function extractMemories(input: ExtractionInput) {
  const scope = scopeFor(input.agent);
  const userTurns = input.history.filter((m) => m.author === "user");
  if (!scope || userTurns.length === 0) {
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
      maxOutputTokens: 400,
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
  for (const [n, fact] of parseFacts(response.text).entries()) {
    const record = await input.memory.write(input.ctx, {
      scope,
      kind: "fact",
      content: fact,
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
