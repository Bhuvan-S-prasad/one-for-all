import { LARKSPUR_NOTES, larkspurWeb } from "../fixtures/larkspur";
import { quillmarkWeb } from "../fixtures/quillmark";
import {
  answered,
  logged,
  replyLacks,
  replyMatches,
  usedTool,
  withinModelCalls,
} from "../graders/checks";
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
  {
    id: "researcher.long-report",
    suite: "golden",
    description:
      "Reads four long pages in a small context window, so the harness compacts mid-task, then still writes the report itself, keeping facts from the first and last pages, instead of replying with its compaction notes.",
    agent: researcher,
    prompt:
      "Read all four pages of the Quillmark guide (overview, capture, distil and review) and write me a short report on the method, with its rule for each stage. Cite the pages.",
    web: quillmarkWeb,
    // An 11.5k window: the fourth 6,000-character page passes 70% of the input budget
    // (10.5k–12k works with the current prompt; retune if the prompt or tool list grows).
    harness: { maxContextTokens: 11_500 },
    checks: [
      answered,
      usedTool("web.read_url"),
      logged("run.compacted"),
      replyLacks(
        "is the answer, not the compaction notes",
        /#+\s*(Decisions made|Facts learned|Open items|Artifacts produced)/i,
      ),
      replyMatches("keeps the capture rule (read early)", /48\s*hours/i),
      replyMatches("keeps the distil rule", /three sentences|3 sentences/i),
      replyMatches("keeps the review rule (read last)", /friday/i),
      withinModelCalls(12),
    ],
  },
];
