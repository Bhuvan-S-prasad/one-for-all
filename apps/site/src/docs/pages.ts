// The docs' table of contents. Written pages are Markdown in ./content; the
// decisions come from docs/adr and the run events from @ofa/contracts.

const content = import.meta.glob("./content/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface DocPage {
  readonly slug: string;
  readonly title: string;
  /** One line under the title, and on the docs home. */
  readonly summary: string;
  /** Markdown, for written pages; generated pages have none. */
  readonly source?: string;
}

export interface DocSection {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

function written(slug: string, title: string, summary: string): DocPage {
  const source = content[`./content/${slug}.md`];
  if (source === undefined) throw new Error(`No docs page for ${slug}`);
  return { slug, title, summary, source };
}

export const SECTIONS: readonly DocSection[] = [
  {
    title: "Start",
    pages: [
      written(
        "introduction",
        "What One-for-All is",
        "A self-hosted team of AI agents, and the principles behind it.",
      ),
      written("quick-start", "Quick start", "Install with Docker and create your owner account."),
      written(
        "development",
        "Run from source",
        "Hot reload, the dev seed and its sign-in, the local addresses.",
      ),
      written("concepts", "Concepts", "The words the rest of the docs use."),
    ],
  },
  {
    title: "Using it",
    pages: [
      written("agents", "Agents", "Hatching an agent: its look, its job, its tools."),
      written("chats", "Chats", "Writing to agents, reading replies, group chats."),
      written("teams", "Teams", "Handoffs, the coordinator role, and continue."),
      written("approvals", "Approvals", "When an agent asks, and how you answer."),
      written("computer", "The computer", "Each agent's desktop, and taking over."),
      written("apps", "Apps", "Connecting apps through MCP, and granting their tools."),
      written(
        "routines",
        "Routines and reminders",
        "Work on a clock, quiet checks, tasks for later.",
      ),
      written(
        "memory-and-skills",
        "Memory and skills",
        "Facts, episodes, the nightly tidy-up and skills.",
      ),
    ],
  },
  {
    title: "How it works",
    pages: [
      written(
        "architecture",
        "Architecture",
        "Nine layers, ports and adapters, and the rules between them.",
      ),
      written("a-run", "A task, end to end", "One request through every layer."),
      written("harness", "The harness", "The loop around the model, and when it stops."),
      written(
        "context-engineering",
        "Context engineering",
        "Budgeted blocks, compaction and versioned prompts.",
      ),
      written("policy", "Policy and taint", "How every tool call is decided."),
      written(
        "sandbox",
        "The computer, inside",
        "Isolation, the desktop, VNC and the egress proxy.",
      ),
      written("models", "Models", "Tiers, the shared queue, fallback and providers."),
      written("security", "Security", "Threats, secrets, the perimeter and tenancy."),
      written(
        "reliability",
        "Reliability and evals",
        "Durable steps, the run log, and testing behaviour.",
      ),
      written("data-model", "Data model", "The tables, and row-level security."),
    ],
  },
  {
    title: "Decisions",
    pages: [
      {
        slug: "decisions",
        title: "Decision records",
        summary: "Every architectural decision, with what was rejected and why.",
      },
    ],
  },
  {
    title: "Reference",
    pages: [
      written("tools", "Built-in tools", "Every tool an agent can be granted."),
      {
        slug: "events",
        title: "Run events",
        summary: "The append-only log every run writes.",
      },
      written("commands", "Commands", "Everything you can run from the repository."),
      written("configuration", "Configuration", "The environment variables the app reads."),
      written("milestones", "Milestones", "What has been built, slice by slice."),
    ],
  },
];

export const ALL_PAGES: readonly DocPage[] = SECTIONS.flatMap((s) => s.pages);

export const pageBySlug = new Map(ALL_PAGES.map((p) => [p.slug, p]));

/** The pages before and after one, in reading order. */
export function neighbours(slug: string): { prev?: DocPage; next?: DocPage } {
  const i = ALL_PAGES.findIndex((p) => p.slug === slug);
  return { prev: i > 0 ? ALL_PAGES[i - 1] : undefined, next: ALL_PAGES[i + 1] };
}
