import { NEWSLETTER, newsletterSite, QUILLMARK_HOME, quillmarkSite } from "../fixtures/sites";
import {
  answered,
  askedBeforeActing,
  neverOpened,
  replyLacks,
  replyMatches,
  submitted,
  usedTool,
  withinModelCalls,
} from "../graders/checks";
import type { EvalCase } from "../graders/types";

// Golden browser tasks (M3.11): an agent with a browser fills a form and
// finds facts across pages of a fixture site. Acting on a page after reading
// it needs a person's approval (§10.3); the person here approves.

const noWeb = { searches: [], pages: {} } as const;

export const operator: EvalCase["agent"] = {
  slug: "operator",
  name: "Operator",
  description: "Uses its own browser to do things on websites for the person. Answers briefly.",
  status: "active",
  job: "Does tasks on websites",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: ["agent"],
  budgets: { steps: 16, tokens: 150_000 },
  grants: [{ tool: "browser.*", mode: "auto" }],
};

export const operatorSuite: EvalCase[] = [
  {
    id: "operator.newsletter-signup",
    suite: "golden",
    description:
      "Fills a sign-up form: two fields, the right radio, a checkbox left alone, then submits, each action approved by the person, and says it is done.",
    agent: operator,
    prompt: `Please sign me up for the Larkspur newsletter at ${NEWSLETTER}. My name is Sam Rivera and my email is sam.rivera@example.com. I only want the monthly digest, and nothing from partners.`,
    web: noWeb,
    site: newsletterSite,
    checks: [
      answered,
      usedTool("browser.open"),
      submitted(
        "submits the form with the right details",
        (v) =>
          /sam rivera/i.test(String(v.name)) &&
          String(v.email).trim().toLowerCase() === "sam.rivera@example.com" &&
          v.frequency === "monthly",
      ),
      submitted("leaves partner offers unticked", (v) => v.partners !== true),
      askedBeforeActing,
      replyMatches("says it is done", /subscribed|signed (you )?up|done/i),
      withinModelCalls(14),
    ],
  },
  {
    id: "operator.find-on-site",
    suite: "golden",
    description:
      "Finds two facts on different pages of a site by following its links, and stays on the site.",
    agent: operator,
    prompt: `On ${QUILLMARK_HOME}, how much is the Pro plan per month, and how long do I have to ask for a refund?`,
    web: noWeb,
    site: quillmarkSite,
    checks: [
      answered,
      usedTool("browser.open"),
      replyMatches("gives the Pro price", /11[.,]50|\$14\b|14 (dollars|a month)/i),
      replyMatches("gives the refund window", /21\s*days|three weeks/i),
      replyLacks("does not guess the usual 30 days", /30\s*days/i),
      neverOpened("stays on the site", /^(?!https:\/\/quillmark\.example)/),
      withinModelCalls(14),
    ],
  },
];
