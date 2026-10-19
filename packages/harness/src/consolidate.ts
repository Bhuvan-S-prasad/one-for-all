import type {
  ConsolidationResult,
  LLMGateway,
  MemoryMaintenance,
  StepRunner,
  TenantContext,
} from "@ofa/core";
import { isPlaceholder, lastJsonObject } from "./json";
import { MEMORY_CONSOLIDATION, promptRef } from "./prompts";
import { truncateToTokens } from "./tokens";

// Nightly consolidation (ARCHITECTURE.md §8, M5.09). For one agent, a fast
// model reads its saved facts and its recent, untainted work, and says which
// facts to merge, what new facts the work shows and which procedures are
// worth proposing as skills. The changes go through `MemoryMaintenance`; a
// person approves proposed skills before any agent uses them.

const FACTS = 60;
const EPISODES = 30;
const NEW_FACTS = 5;
const SKILLS = 2;

export interface ConsolidationPlan {
  readonly merge: readonly { readonly ids: readonly string[]; readonly fact: string }[];
  readonly facts: readonly string[];
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly steps: readonly string[];
  }[];
}

const text = (v: unknown, max: number) =>
  typeof v === "string" && v.trim().length > 0 && v.trim().length <= max && !isPlaceholder(v)
    ? v.trim()
    : null;

/** Read the model's plan, keeping only well-formed parts. */
export function parsePlan(reply: string): ConsolidationPlan {
  const parsed = lastJsonObject(reply, ["merge", "facts", "skills"]) ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    merge: list(parsed.merge).flatMap((m) => {
      const { ids, fact } = (m ?? {}) as { ids?: unknown; fact?: unknown };
      const content = text(fact, 300);
      const keys = list(ids).filter((id): id is string => typeof id === "string");
      return content && keys.length >= 2 ? [{ ids: keys, fact: content }] : [];
    }),
    facts: list(parsed.facts)
      .map((f) => text(f, 300))
      .filter((f): f is string => !!f && f.length >= 8)
      .slice(0, NEW_FACTS),
    skills: list(parsed.skills)
      .flatMap((k) => {
        const { name, description, steps } = (k ?? {}) as Record<string, unknown>;
        const n = text(name, 80);
        const d = text(description, 500);
        const s = list(steps)
          .map((step) => text(step, 500))
          .filter((step): step is string => !!step);
        return n && d && s.length >= 2 && s.length <= 12
          ? [{ name: n, description: d, steps: s }]
          : [];
      })
      .slice(0, SKILLS),
  };
}

export interface ConsolidateInput {
  readonly ctx: TenantContext;
  /** One agent's memory, or null for the shared workspace facts. */
  readonly agentId: string | null;
  readonly now: Date;
}

/** One agent's (or the workspace's) nightly pass, in one durable step. */
export async function consolidateMemory(
  input: ConsolidateInput,
  deps: { readonly llm: LLMGateway; readonly maintenance: MemoryMaintenance },
  steps: StepRunner,
): Promise<ConsolidationResult> {
  const { ctx, agentId, now } = input;
  const { maintenance } = deps;
  return steps.run(`consolidate-${agentId ?? "workspace"}`, async () => {
    const result = { merged: 0, added: 0, expired: 0, proposedSkills: 0, modelCalls: 0 };
    const facts = await maintenance.facts(ctx, agentId, FACTS);
    // Only an agent has work of its own, and only untainted work is read.
    const episodes = agentId ? await maintenance.newEpisodes(ctx, agentId, EPISODES) : [];
    if (facts.length >= 2 || episodes.length > 0) {
      // Short handles instead of IDs: fewer tokens, and the model can't invent one that exists.
      const handles = new Map(facts.map((f, i) => [`f${i + 1}`, f.id]));
      const response = await deps.llm.generate(
        {
          tier: "fast",
          messages: [
            {
              role: "user",
              content: MEMORY_CONSOLIDATION.render({
                facts: truncateToTokens(
                  facts.map((f, i) => `f${i + 1}: ${f.content}`).join("\n"),
                  3_000,
                ),
                episodes: truncateToTokens(
                  episodes
                    .map((e) => `- ${e.summary}${e.outcome === "done" ? "" : ` (${e.outcome})`}`)
                    .join("\n"),
                  3_000,
                ),
              }),
            },
          ],
          maxOutputTokens: 6_000,
          reasoning: "low",
          temperature: 0,
          promptVersion: promptRef(MEMORY_CONSOLIDATION),
        },
        ctx,
      );
      result.modelCalls = 1;
      const plan = parsePlan(response.text);
      const used = new Set<string>();
      for (const merge of plan.merge) {
        const ids = [...new Set(merge.ids)]
          .filter((h) => !used.has(h))
          .flatMap((h) => (handles.has(h) ? [handles.get(h)!] : []));
        if (ids.length < 2) continue;
        if (await maintenance.merge(ctx, { agentId, ids, content: merge.fact, now })) {
          for (const h of merge.ids) used.add(h);
          result.merged += 1;
        }
      }
      // New facts and skills come only from the agent's own untainted work.
      // The model also saw the agent's facts, and an unverified one (from a
      // run that read outside content) could come back reworded as "new": so
      // a new fact is verified only if every fact it was shown was (ADR-0037).
      if (agentId && episodes.length > 0) {
        const verified = facts.every((f) => f.verified);
        for (const fact of plan.facts) {
          await maintenance.addFact(ctx, { agentId, content: fact, verified });
          result.added += 1;
        }
        for (const skill of plan.skills) {
          if (await maintenance.proposeSkill(ctx, { agentId, ...skill })) {
            result.proposedSkills += 1;
          }
        }
      }
    }
    if (agentId) await maintenance.closeEpisodes(ctx, agentId, now);
    return result;
  });
}
