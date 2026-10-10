import type { RunContext } from "../tenant";

// Procedural memory (ARCHITECTURE.md §8, M5.08): skills are instructions only
// (ADR-0018). The harness and the skill tools read and write them here.

export interface SkillSummary {
  readonly slug: string;
  readonly name: string;
  /** When to use it. */
  readonly description: string;
}

export interface SkillInstructions extends SkillSummary {
  readonly steps: readonly string[];
}

export interface SkillLibrary {
  /** Active skills this run's agent may use: its own and the shared ones. */
  list(ctx: RunContext): Promise<SkillSummary[]>;
  /** One of those, by handle or name (any case, a leading `/` ignored); null if none. */
  find(ctx: RunContext, name: string): Promise<SkillInstructions | null>;
  /**
   * Keep a procedure the agent just did as its own skill. Active when the run
   * read no outside content; otherwise proposed, for a person to approve.
   */
  save(
    ctx: RunContext,
    input: {
      readonly name: string;
      readonly description: string;
      readonly steps: readonly string[];
      readonly tainted: boolean;
    },
  ): Promise<{ readonly slug: string; readonly status: "active" | "proposed" }>;
}

/** `/slug` written as a word of its own (not inside an address or a path). */
const SKILL_REFERENCE = /(?:^|\s)\/([a-z0-9][a-z0-9-]{1,59})(?=$|[\s.,!?;:])/gi;

/** The `/name` references in a message, in order, lower-cased. */
export function skillReferences(text: string): string[] {
  return [...text.matchAll(SKILL_REFERENCE)].map((m) => m[1]!.toLowerCase());
}

/** A slug from a name: `Morning pipeline review` → `morning-pipeline-review`. */
export function skillSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : `skill-${slug || "x"}`;
}
