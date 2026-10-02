import { useAgents } from "@ofa/client";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { ComingSoon } from "@/components/coming-soon";
import { Familiar } from "@/components/familiar";
import { MoodPill } from "@/components/mood-pill";
import { ErrorAlert } from "@/components/ui/alert";
import { HOUSEHOLD } from "@/lib/familiars";
import { serialFor, useAgentMoods } from "@/lib/agents";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/agents/")({
  staticData: { title: "Agents" },
  component: AgentsPage,
});

const FILTERS = ["all", "running", "stuck"] as const;
type Filter = (typeof FILTERS)[number];

/** "The den": every agent with its familiar and what it is doing (design canvas, Agents). */
function AgentsPage() {
  const { data: agents, isPending, error } = useAgents();
  const moods = useAgentMoods(agents);
  const [filter, setFilter] = useState<Filter>("all");

  if (error) return <ErrorAlert>Couldn't load your agents: {error.message}</ErrorAlert>;
  if (isPending) return <p className="text-muted-foreground">Loading…</p>;

  const busy = (id: string) =>
    ["thinking", "working", "waiting"].includes(moods.get(id)?.mood ?? "");
  const stuck = (id: string) => moods.get(id)?.mood === "error";
  const counts = {
    all: agents.length,
    running: agents.filter((a) => busy(a.id)).length,
    stuck: agents.filter((a) => stuck(a.id)).length,
  };
  const shown = agents.filter(
    (a) => filter === "all" || (filter === "running" ? busy(a.id) : stuck(a.id)),
  );

  if (agents.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <ComingSoon
          familiar={HOUSEHOLD.scout}
          mood="idle"
          heading="No agents yet"
          badge="Start here"
        >
          Each agent does one job, with the tools you grant it and a memory of its own. Hatch your
          first one.
        </ComingSoon>
        <Link
          to="/agents/new"
          className="flex h-14 items-center gap-2 self-center rounded-full bg-primary px-6 font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-[18px]" aria-hidden /> Hatch an agent
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h2 className="text-[48px] leading-[0.95] font-extrabold tracking-[-0.04em] md:text-[64px]">
          The den{" "}
          <span className="text-muted-foreground/60">{String(agents.length).padStart(2, "0")}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2.5">
          <div role="group" aria-label="Filter" className="flex gap-1 rounded-full border p-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  filter === f
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f === "stuck" && (
                  <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                )}
                {f === "all"
                  ? "All"
                  : f === "running"
                    ? `Running ${counts.running}`
                    : `Stuck ${counts.stuck}`}
              </button>
            ))}
          </div>
          <Link
            to="/agents/new"
            className="flex h-12 items-center gap-2 rounded-full bg-primary px-5 text-[15px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-[18px]" aria-hidden /> Hatch an agent
          </Link>
        </div>
      </header>

      {shown.length === 0 ? (
        <p className="text-muted-foreground">Nothing here right now.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((agent) => {
            const { mood, run } = moods.get(agent.id) ?? { mood: "idle" as const };
            return (
              <li key={agent.id}>
                <Link
                  to="/agents/$agentId"
                  params={{ agentId: agent.id }}
                  className={cn(
                    "flex flex-col overflow-hidden rounded-lg border bg-card outline-none transition-colors hover:border-input focus-visible:ring-2 focus-visible:ring-ring",
                    mood === "error" && "border-destructive/40",
                  )}
                >
                  <div className="bg-dots relative flex h-44 items-end justify-center">
                    <span className="eyebrow absolute top-4 left-4 text-[11px] text-muted-foreground">
                      {serialFor(agent.id)}
                    </span>
                    <MoodPill mood={mood} className="absolute top-3 right-3" />
                    <Familiar
                      look={agent.spec.avatar}
                      mood={mood}
                      size={160}
                      ring="var(--card)"
                      label={`${agent.name} familiar`}
                    />
                  </div>
                  <div className="flex flex-col gap-3 px-5 pt-4 pb-4.5">
                    <div className="flex flex-col gap-0.5">
                      <h3 className="text-[26px] leading-tight font-bold tracking-[-0.02em]">
                        {agent.name}
                      </h3>
                      <p className="truncate text-sm text-muted-foreground">{agent.spec.job}</p>
                    </div>
                    <div className="flex min-h-9 items-center border-t pt-3 font-mono text-[13px] text-muted-foreground">
                      {agent.status !== "active"
                        ? `${agent.status === "paused" ? "Paused" : "Archived"}`
                        : run
                          ? `Last run ${timeAgo(run.createdAt)}`
                          : "Hasn't run yet"}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
