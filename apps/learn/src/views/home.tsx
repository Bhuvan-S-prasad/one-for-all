import { Link } from "@tanstack/react-router";
import { Layout } from "@/components/layout";
import { Loading } from "@/components/panels";
import { useIndex, type Index } from "@/lib/data";
import { packageHref } from "@/lib/links";
import { SECTIONS } from "@/lib/pages";

// Start here: what this is, the system as one map of its layers (each
// package a link), and where to begin.

/** The layers, top (what people touch) to bottom (what everything stands on). */
const MAP: { layer: string; does: string; packages: string[] }[] = [
  {
    layer: "Clients",
    does: "What people use: the web app, the public site.",
    packages: ["web", "site", "client"],
  },
  {
    layer: "API",
    does: "HTTP and WebSocket: sign-in, chats, agents, approvals. Never runs an agent.",
    packages: ["api"],
  },
  {
    layer: "Orchestration",
    does: "Durable jobs on Inngest: when and how often an agent runs, retries, schedules.",
    packages: ["orchestrator"],
  },
  {
    layer: "Agent harness",
    does: "The agent loop: what the model reads, the tools it gets, when it stops.",
    packages: ["harness", "llm"],
  },
  {
    layer: "Tools and policy",
    does: "Every tool call checked and run: built-in tools, apps over MCP, secrets.",
    packages: ["tools", "policy", "mcp", "vault"],
  },
  {
    layer: "Memory and the computer",
    does: "What agents remember, and each agent's own sandboxed computer.",
    packages: ["memory", "sandbox", "video", "blobs"],
  },
  {
    layer: "Data and events",
    does: "Postgres with row-level security, and the event bus for live updates.",
    packages: ["db", "events"],
  },
  {
    layer: "Foundations",
    does: "Shared types, ports, zod contracts, config and telemetry every layer builds on.",
    packages: ["core", "contracts", "config", "telemetry"],
  },
  {
    layer: "Checks",
    does: "Agent behaviour tested against live models, on fixtures.",
    packages: ["evals"],
  },
];

function SystemMap({ index }: { index: Index }) {
  return (
    <div className="flex flex-col gap-1.5" role="list" aria-label="The system, layer by layer">
      {MAP.map((row, i) => (
        <div
          key={row.layer}
          role="listitem"
          className="grid gap-x-6 gap-y-2 rounded-[16px] px-4 py-3.5 md:grid-cols-[220px_1fr]"
          style={{
            background: `color-mix(in oklab, var(--primary) ${Math.max(4, 20 - i * 2)}%, var(--card))`,
          }}
        >
          <div className="flex flex-col">
            <span className="font-display text-[17px] font-bold">{row.layer}</span>
            <span className="text-[13.5px] text-muted-foreground">{row.does}</span>
          </div>
          <div className="flex flex-wrap content-start gap-2">
            {row.packages
              .filter((k) => index.packageByKey.has(k))
              .map((k) => {
                const pkg = index.packageByKey.get(k)!;
                return (
                  <Link
                    key={k}
                    to={packageHref(k)}
                    title={pkg.description}
                    className="rounded-full border border-border bg-background/60 px-3 py-1 font-mono text-[13px] hover:border-primary hover:text-primary"
                  >
                    {pkg.dir}
                  </Link>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Home() {
  const { data: index, error } = useIndex();
  const first = SECTIONS[0]?.pages[0];
  const walk = SECTIONS.find((s) => s.key === "walkthroughs")?.pages[0];
  const stats = index
    ? [
        [index.packages.length, "packages"],
        [Object.keys(index.files).length, "source files"],
        [Object.keys(index.symbols).length, "functions, types and constants"],
        [index.tables.length, "database tables"],
        [index.routes.length, "API endpoints"],
        [index.tools.length, "agent tools"],
      ]
    : [];
  return (
    <Layout wide>
      <div className="max-w-[1080px]">
        <header className="mb-10 flex flex-col gap-4">
          <span className="eyebrow text-[11.5px] text-muted-foreground">Learn One-for-All</span>
          <h1 className="max-w-[18ch] text-[clamp(36px,5vw,60px)] leading-[1.02] font-extrabold">
            How a team of AI agents is built, down to each function.
          </h1>
          <p className="max-w-[66ch] text-[18px] text-muted-foreground">
            One-for-All is a self-hosted platform where AI agents each have one job, their own
            computer, tools and memory. This guide walks through how it works: the architecture,
            each feature, the data model and APIs, and every function with what calls what. The
            facts about the code come from the code itself, rebuilt with every build.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            {first && (
              <Link
                to={`/path/${first.slug}`}
                className="rounded-full bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:bg-primary/85"
              >
                Start the guided path
              </Link>
            )}
            {walk && (
              <Link
                to={`/walkthroughs/${walk.slug}`}
                className="rounded-full border border-input px-5 py-2.5 font-semibold hover:bg-card"
              >
                Follow one message through the system
              </Link>
            )}
            <Link
              to="/code"
              className="rounded-full border border-input px-5 py-2.5 font-semibold hover:bg-card"
            >
              Explore the code
            </Link>
          </div>
        </header>

        {error && <p className="text-destructive">{error.message}</p>}
        {!index && !error && <Loading />}
        {index && (
          <>
            <dl className="mb-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {stats.map(([n, label]) => (
                <div key={label} className="rounded-[16px] bg-card px-4 py-3">
                  <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
                  <dd className="font-display text-[26px] font-bold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            <section className="mb-14">
              <h2 className="mb-2 text-[28px] font-bold">The system on one page</h2>
              <p className="mb-5 max-w-[68ch] text-muted-foreground">
                A layer only calls the layers below it. Each name is a package in the repository;
                open one to see its files, its most used functions and what depends on it.
              </p>
              <SystemMap index={index} />
            </section>
          </>
        )}

        <section className="grid gap-4 md:grid-cols-3">
          {SECTIONS.map((s) => (
            <Link
              key={s.key}
              to={`/${s.key}`}
              className="flex flex-col gap-2 rounded-[20px] border border-border bg-card p-5 hover:border-primary"
            >
              <span className="font-display text-[20px] font-bold">{s.title}</span>
              <span className="text-[14.5px] text-muted-foreground">{s.intro}</span>
              <span className="mt-auto pt-2 text-[13px] text-muted-foreground">
                {s.pages.length} {s.pages.length === 1 ? "page" : "pages"}
              </span>
            </Link>
          ))}
        </section>
      </div>
    </Layout>
  );
}
