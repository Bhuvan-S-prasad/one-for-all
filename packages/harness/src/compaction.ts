import type { LLMGateway, LLMResponse, RunContext } from "@ofa/core";
import type { Turn } from "./context";
import { COMPACTION, promptRef } from "./prompts";
import { truncateToTokens } from "./tokens";

// Structured compaction (ARCHITECTURE.md §7): when a run's steps fill 70% of
// the input budget, older steps become a sectioned summary (decisions, facts,
// open items, artifacts) and only the latest steps stay verbatim.

/** Steps kept verbatim after compaction: the latest model turn and its tool results. */
function splitPoint(turns: readonly Turn[]): number {
  for (let i = turns.length - 1; i > 0; i -= 1) {
    if (turns[i]?.kind === "assistant") return i;
  }
  return 0;
}

export function transcriptOf(turns: readonly Turn[]): string {
  return turns
    .map((turn) =>
      turn.kind === "assistant"
        ? `Agent: ${turn.text}${turn.toolCalls.map((c) => `\n  called ${c.name} ${JSON.stringify(c.args)}`).join("")}`
        : turn.kind === "user"
          ? `The person added: ${turn.text}`
          : `Result of ${turn.toolName}: ${truncateToTokens(turn.content, 1_500)}`,
    )
    .join("\n");
}

export interface CompactionResult {
  readonly summary: string;
  /** How many leading turns the summary replaces. */
  readonly replaced: number;
  readonly promptVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** For the run log: which model answered, and any that failed first. */
  readonly response: LLMResponse;
}

export const COMPACTION_OUTPUT_TOKENS = 4_000;

/** Summarise all but the latest turn group. Returns null when there is nothing to fold. */
export async function compactTurns(
  llm: LLMGateway,
  ctx: RunContext,
  previous: string | null,
  turns: readonly Turn[],
): Promise<CompactionResult | null> {
  const cut = splitPoint(turns);
  if (cut === 0) return null;
  const response = await llm.generate(
    {
      tier: "fast",
      messages: [
        {
          role: "user",
          content: COMPACTION.render({
            previous: previous ?? "",
            transcript: transcriptOf(turns.slice(0, cut)),
          }),
        },
      ],
      // Room for reasoning models, which spend output tokens thinking before
      // they write; 1,500 cut summaries off mid-sentence (session 8).
      maxOutputTokens: COMPACTION_OUTPUT_TOKENS,
      temperature: 0,
      promptVersion: promptRef(COMPACTION),
    },
    ctx,
  );
  const summary = response.text.trim();
  return {
    // No notes came back: keep the steps as they are rather than lose them.
    summary: summary || (previous ?? ""),
    replaced: summary ? cut : 0,
    promptVersion: promptRef(COMPACTION),
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: response.usage.costUsd,
    response,
  };
}
