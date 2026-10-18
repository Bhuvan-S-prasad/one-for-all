import { asId, type AgentCapability, type TeamMember } from "@ofa/core";
import type { FamiliarLook } from "@ofa/contracts";

// The sample team the site shows. Cards are written the way the tool executor
// builds them from grants (ADR-0044), so the routing demo reads what a real
// coordinator reads.

export interface SiteAgent {
  readonly slug: string;
  readonly name: string;
  readonly job: string;
  readonly look: FamiliarLook;
  readonly capabilities: readonly AgentCapability[];
}

export const CHIEF: SiteAgent = {
  slug: "chief-of-staff",
  name: "Chief of staff",
  job: "Owns the outcome: plans, hands work to the team and checks what comes back",
  look: { form: "bloom", eyes: "googly", skin: "solid", color: "acid", mark: "halo" },
  capabilities: [
    { area: "web", abilities: ["search", "read pages"], tools: ["web.search", "web.read_url"] },
    {
      area: "Gmail",
      abilities: ["create draft (asks first)"],
      tools: ["gmail.create_draft"],
    },
    {
      area: "files",
      abilities: ["read", "write"],
      tools: ["files.read", "files.write"],
    },
  ],
};

export const TEAM: readonly SiteAgent[] = [
  {
    slug: "researcher",
    name: "Researcher",
    job: "Researches anything on the web and compares the options, with sources",
    look: { form: "drop", eyes: "rings", skin: "dots", color: "cobalt", mark: "spark" },
    capabilities: [
      { area: "web", abilities: ["search", "read pages"], tools: ["web.search", "web.read_url"] },
    ],
  },
  {
    slug: "operator",
    name: "Operator",
    job: "Operates its own computer: browser, terminal, files and desktop apps",
    look: { form: "totem", eyes: "visor", skin: "stripes", color: "tomato", mark: "cap" },
    capabilities: [
      { area: "web", abilities: ["search", "read pages"], tools: ["web.search", "web.read_url"] },
      {
        area: "browser",
        abilities: ["open websites", "click", "fill in forms"],
        tools: ["browser.open", "browser.click", "browser.type"],
      },
      {
        area: "terminal",
        abilities: ["run commands and Python"],
        tools: ["shell.run"],
      },
      {
        area: "files",
        abilities: ["read", "write", "send files to the person"],
        tools: ["files.read", "files.write", "files.send"],
      },
      {
        area: "desktop apps",
        abilities: ["open files in apps (Word, Excel, text)", "click", "type"],
        tools: ["desktop.open", "desktop.click", "desktop.type"],
      },
    ],
  },
  {
    slug: "inbox",
    name: "Gmail agent",
    job: "Reads my email and writes drafts and replies for me to approve",
    look: { form: "blob", eyes: "beans", skin: "waves", color: "lilac", mark: "sprout" },
    capabilities: [
      {
        area: "Gmail",
        abilities: [
          "search messages",
          "read message",
          "create draft (asks first)",
          "send email (asks first)",
        ],
        tools: [
          "gmail.search_messages",
          "gmail.read_message",
          "gmail.create_draft",
          "gmail.send_email",
        ],
      },
    ],
  },
  {
    slug: "writer",
    name: "Writer",
    job: "Writes reports, summaries and announcements in my voice",
    look: { form: "cookie", eyes: "lids", skin: "checker", color: "sun", mark: "horns" },
    capabilities: [],
  },
];

export const members: TeamMember[] = TEAM.map((a) => ({
  id: asId(a.slug),
  slug: a.slug,
  name: a.name,
  job: a.job,
  capabilities: a.capabilities,
}));

export const bySlug = new Map(TEAM.map((a) => [a.slug, a]));

/** The chief's own tools that a teammate covers, so it never sees them (ADR-0044). */
export function coveredTools(): { tool: string; by: string }[] {
  const out: { tool: string; by: string }[] = [];
  for (const tool of CHIEF.capabilities.flatMap((c) => c.tools)) {
    const owner = TEAM.find((m) => m.capabilities.some((c) => c.tools.includes(tool)));
    if (owner) out.push({ tool, by: owner.name });
  }
  return out;
}
