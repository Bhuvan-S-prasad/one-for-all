import { larkspurWeb } from "../fixtures/larkspur";
import { MAIL_OWNER, SAM } from "../fixtures/mailbox";
import {
  answered,
  delegatedOnly,
  delegatedTo,
  handedOffAfter,
  neverUsed,
  replyMatches,
  sentOnly,
  stoppedFirst,
  teammateUsedTool,
  withinModelCalls,
} from "../graders/checks";
import type { EvalCase } from "../graders/types";
import { researcher } from "./researcher";

// Teams and continuity (TC.08): "continue" after a budget stop picks up from
// the chat record instead of starting over (ADR-0045), and a coordinator
// routes work by capability, outbound last, even in a large team (ADR-0044).

/** Larkspur 3.0's date, as the fixture's release notes give it. */
const RELEASE_DATE = /14(th)?\s+aug(ust)?,?\s+2026|aug(ust)?\s+14(th)?,?\s+2026|2026-08-14/i;

/** Does a small job end to end with web and mail. */
const assistant: EvalCase["agent"] = {
  slug: "assistant",
  name: "Assistant",
  description: "Looks things up and emails people for me. Answers briefly.",
  status: "active",
  job: "Looks things up and sends email",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: ["agent"],
  // Two steps: enough to search and read, not to send. The person raises it to continue.
  budgets: { steps: 2, tokens: 120_000 },
  grants: [
    { tool: "web.search", mode: "auto" },
    { tool: "web.read_url", mode: "auto" },
    { tool: "todo.write", mode: "auto" },
    { tool: "mail.*", mode: "auto" },
  ],
};

/** A coordinator that holds the same tools as its team: hiding them is the test. */
const chief: EvalCase["agent"] = {
  slug: "chief",
  name: "Chief",
  description: "Gets things done through the team. Answers briefly.",
  status: "active",
  job: "Coordinates the team",
  role: "coordinator",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: ["agent"],
  budgets: { steps: 10, tokens: 120_000 },
  grants: [
    { tool: "delegate_task", mode: "auto" },
    { tool: "todo.write", mode: "auto" },
    { tool: "web.search", mode: "auto" },
    { tool: "web.read_url", mode: "auto" },
    { tool: "mail.*", mode: "auto" },
  ],
};

const mailer: EvalCase["agent"] = {
  slug: "mailer",
  name: "Mailer",
  description: "Writes and sends short, friendly emails.",
  status: "active",
  job: "Sends email",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: ["agent"],
  budgets: { steps: 6, tokens: 60_000 },
  grants: [{ tool: "mail.*", mode: "auto" }],
};

/** Teammates with jobs that have nothing to do with the request. */
const DECOYS = [
  ["travel", "Travel", "Plans trips and books travel"],
  ["books", "Books", "Bookkeeping and invoices"],
  ["translator", "Translator", "Translates documents"],
  ["designer", "Designer", "Designs logos and slides"],
  ["counsel", "Counsel", "Reviews contracts"],
  ["chef", "Chef", "Plans meals and recipes"],
  ["coach", "Coach", "Writes fitness plans"],
  ["gardener", "Gardener", "Gardening advice"],
  ["social", "Social", "Writes social media posts"],
] as const;

const decoys: EvalCase["agent"][] = DECOYS.map(([slug, name, job]) => ({
  slug,
  name,
  description: "",
  status: "active",
  job,
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: ["agent"],
  budgets: { steps: 4, tokens: 40_000 },
  grants: [],
}));

const emailsSamTheDate = sentOnly(
  "emails only Sam, with the date",
  (m) => m.to.trim().toLowerCase() === SAM && RELEASE_DATE.test(m.body),
);

export const continuitySuite: EvalCase[] = [
  {
    id: "continuity.continue-after-budget",
    suite: "golden",
    description:
      'The first run stops at its step budget after looking things up. The person raises the budget and says "continue": the next run uses the chat record (what was searched and read) to email Sam the date without searching again.',
    agent: assistant,
    prompt: `Find out when Larkspur 3.0 was released, then email ${SAM} a one-line note with the date.`,
    web: larkspurWeb,
    mailbox: { owner: MAIL_OWNER, messages: [] },
    continueWith: { prompt: "continue", agent: { budgets: { steps: 8, tokens: 120_000 } } },
    checks: [
      stoppedFirst,
      answered,
      neverUsed("web.search"),
      emailsSamTheDate,
      withinModelCalls(6),
    ],
  },
  {
    id: "team.coordinator-routes",
    suite: "golden",
    description:
      "A coordinator granted the same web and mail tools as its team hands the research to the researcher and the email to the mailer, after the research and with its result, and does neither itself.",
    agent: chief,
    team: [researcher, mailer],
    prompt: `Find out when Larkspur 3.0 was released and get an email sent to ${SAM} with the date.`,
    web: larkspurWeb,
    mailbox: { owner: MAIL_OWNER, messages: [] },
    checks: [
      answered,
      delegatedTo("researcher"),
      teammateUsedTool("researcher", "web.search"),
      handedOffAfter("researcher", "mailer", RELEASE_DATE),
      neverUsed("web.search"),
      neverUsed("mail.send_message"),
      emailsSamTheDate,
    ],
  },
  {
    id: "team.large-roster",
    suite: "golden",
    description:
      "A coordinator with ten teammates, nine of them unrelated, hands a research question to the researcher only, picked by what each can do.",
    agent: chief,
    team: [...decoys.slice(0, 5), researcher, ...decoys.slice(5)],
    prompt: "When was Larkspur 3.0 released?",
    web: larkspurWeb,
    checks: [
      answered,
      delegatedTo("researcher"),
      delegatedOnly(["researcher"]),
      replyMatches("gives the release date", RELEASE_DATE),
      withinModelCalls(4),
    ],
  },
];
