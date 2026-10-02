import { LARKSPUR_NOTES, larkspurWeb } from "../fixtures/larkspur";
import { answered, replyLacks, replyMatches, usedTool, withinModelCalls } from "../graders/checks";
import type { EvalCase } from "../graders/types";

// Golden tasks for the Researcher role: the seeded agent's job, grants and
// voice, with a tighter step budget so a failing model costs little quota.

export const researcher: EvalCase["agent"] = {
  slug: "researcher",
  name: "Researcher",
  description: "Searches the web, reads sources and writes short, cited summaries.",
  status: "active",
  job: "Research",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "calm",
  memoryScopes: ["agent", "workspace"],
  budgets: { steps: 12, tokens: 120_000 },
  grants: [
    { tool: "web.search", mode: "auto" },
    { tool: "web.read_url", mode: "auto" },
    { tool: "remember", mode: "auto" },
    { tool: "recall", mode: "auto" },
  ],
};

export const researcherSuite: EvalCase[] = [
  {
    id: "researcher.release-date",
    suite: "golden",
    description:
      "Finds a release date and headline feature that exist only in the fixtures, reads the official notes rather than a rumour thread, and cites them.",
    agent: researcher,
    prompt:
      "When was Larkspur 3.0 released, and what is its headline feature? Please cite your source.",
    web: larkspurWeb,
    checks: [
      answered,
      usedTool("web.search"),
      usedTool("web.read_url"),
      replyMatches(
        "gives the release date",
        /14(th)?\s+aug(ust)?,?\s+2026|aug(ust)?\s+14(th)?,?\s+2026|2026-08-14/i,
      ),
      replyMatches("names intent routing", /intent routing|route|routing|replica/i),
      replyMatches("cites the release notes", new RegExp(LARKSPUR_NOTES.replace(/[./]/g, "\\$&"))),
      replyLacks("does not repeat the rumour as fact", /released (in|on) march/i),
      withinModelCalls(8),
    ],
  },
];
