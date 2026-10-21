import {
  answered,
  closeReflects,
  discussionInOrder,
  discussionWithin,
  everyMemberSpoke,
  replyMatches,
} from "../graders/checks";
import type { EvalCase } from "../graders/types";

// Group discussions (ADR-0050): members answer one at a time in a fixed
// order, each reading the turns before it, for at most a few rounds, and the
// coordinator closes with one agreed answer. Each member knows one thing the
// others don't (in its standing rules), so a close that reflects every
// member has to carry all three.

const member = (
  slug: string,
  name: string,
  job: string,
  description: string,
): EvalCase["agent"] => ({
  slug,
  name,
  description,
  status: "active",
  job,
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: ["agent"],
  budgets: { steps: 4, tokens: 40_000 },
  grants: [],
});

/** Leads the group; closes the discussion. */
const lead: EvalCase["agent"] = {
  ...member(
    "lead",
    "Lead",
    "Leads the team and makes the call",
    "You lead this team's group chat. When a discussion ends, you close it with one decision for the person, built from what each member said.",
  ),
  role: "coordinator",
  budgets: { steps: 4, tokens: 60_000 },
};

const finance = member(
  "finance",
  "Priya",
  "Looks after the budget",
  "You look after the team's money. The yearly budget for this tool is $6,000 at most, and you won't sign off on anything that costs more. Bring the number up whenever cost matters.",
);
const ops = member(
  "ops",
  "Marco",
  "Runs the team's servers",
  "You run the team's servers. Company policy: customer data never leaves our own servers, so any tool that stores tickets must be self-hosted. Bring this up whenever hosting comes up.",
);
const dev = member(
  "dev",
  "Ines",
  "Builds the team's software",
  "You build the team's software. The team writes Python, and nobody has time this quarter to build or maintain a new app. Say so when building something is on the table.",
);

/** The answer is in the members' heads, not on the web. */
const NO_WEB = { pages: {}, searches: [] };

const QUESTION =
  "@all We need a ticket tracker for the support team. Should we build our own, self-host an open-source one, or pay for a hosted one? I want one recommendation.";

export const discussionSuite: EvalCase[] = [
  {
    id: "discussion.pick-a-tracker",
    suite: "golden",
    description:
      "Three members each hold one constraint (a $6,000 budget, data on our own servers, no time to build); they answer in order over up to two rounds, and the coordinator's close recommends self-hosting an open-source tracker and credits each member's point by name.",
    agent: lead,
    discussion: { members: [finance, ops, dev], rounds: 2 },
    prompt: QUESTION,
    web: NO_WEB,
    checks: [
      answered,
      discussionInOrder,
      discussionWithin(2),
      everyMemberSpoke,
      closeReflects("credits Priya's budget", "Priya", /\$?6,?000|6k|budget/i),
      closeReflects("credits Marco's hosting rule", "Marco", /own servers|self-host|on-prem/i),
      closeReflects("credits Ines on building", "Ines", /build|maintain|python/i),
      replyMatches(
        "recommends self-hosting an open-source tracker",
        /open[- ]source[\s\S]*self[- ]host|self[- ]host[\s\S]*open[- ]source/i,
      ),
    ],
  },
  {
    id: "discussion.no-runaway",
    suite: "golden",
    description:
      "Members told to always add one more point still get one turn each per round for three rounds, never a fourth, and the coordinator closes.",
    agent: lead,
    discussion: {
      members: [
        {
          ...finance,
          description: `${finance.description} You love a debate: always add one more point, and never say you have nothing to add.`,
        },
        {
          ...ops,
          description: `${ops.description} You love a debate: always add one more point, and never say you have nothing to add.`,
        },
      ],
      rounds: 3,
    },
    prompt: QUESTION,
    web: NO_WEB,
    checks: [answered, discussionInOrder, discussionWithin(3)],
  },
];
