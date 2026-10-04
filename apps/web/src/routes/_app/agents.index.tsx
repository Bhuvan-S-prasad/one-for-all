import {
  MOOD_LABELS,
  useAgents,
  useAgentStats,
  useRetryRun,
  useRun,
  useStopRun,
  useUpdateAgent,
} from "@ofa/client";
import type { Agent, AgentStats, FamiliarMood, Run } from "@ofa/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, List, Play, Plus, RotateCcw, Search, Square } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import { HOUSEHOLD } from "@/lib/familiars";
import { BUSY_MOODS, shouldAnimate, TIER_INFO, useAgentMoods } from "@/lib/agents";
import { duration, timeAgo } from "@/lib/format";
import { leadingHeading } from "@/lib/markdown";
import { runPhase } from "@/lib/run-steps";
import { useStoredFlag } from "@/lib/shortcuts";
import { toast } from "@/lib/toast";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

// Agents (UX.12): compact cards that say what each agent is doing now or last
// produced, with the one action that matters; search, filters, sort, and a
// list view for when there are many.

const FILTERS = ["all", "working", "needs", "paused"] as const;
type Filter = (typeof FILTERS)[number];
const SORTS = { recent: "Recent activity", name: "Name", newest: "Newest" } as const;
type Sort = keyof typeof SORTS;

interface AgentsSearch {
  q?: string;
  filter?: Exclude<Filter, "all">;
  sort?: Exclude<Sort, "recent">;
}

export const Route = createFileRoute("/_app/agents/")({
  staticData: { title: "Agents" },
  validateSearch: (search: Record<string, unknown>): AgentsSearch => ({
    ...(typeof search.q === "string" && search.q ? { q: search.q.slice(0, 100) } : {}),
    ...(FILTERS.includes(search.filter as Filter) && search.filter !== "all"
      ? { filter: search.filter as AgentsSearch["filter"] }
      : {}),
    ...(search.sort === "name" || search.sort === "newest" ? { sort: search.sort } : {}),
  }),
  component: AgentsPage,
});

type Row = { agent: Agent; mood: FamiliarMood; run?: Run; stats?: AgentStats };

const TOOL_GROUPS: [string, (tool: string) => boolean][] = [
  ["Web", (t) => t.startsWith("web.")],
  ["Memory", (t) => t === "remember" || t === "recall"],
  ["Checklist", (t) => t === "todo.write"],
];

function toolWords(agent: Agent): string[] {
  const tools = agent.grants.filter((g) => g.mode !== "blocked").map((g) => g.tool);
  return TOOL_GROUPS.filter(([, match]) => tools.some(match)).map(([label]) => label);
}

function AgentsPage() {
  const { data: agents, isPending, error } = useAgents();
  const { data: stats } = useAgentStats();
  const moods = useAgentMoods(agents);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [list, setList] = useStoredFlag("ofa-agents-list", false);
  const setSearch = (patch: Partial<AgentsSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  if (error) return <ErrorAlert>Couldn't load your agents: {error.message}</ErrorAlert>;
  if (isPending) return <AgentsSkeleton />;

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

  const statsById = new Map((stats ?? []).map((s) => [s.agentId, s]));
  const rows: Row[] = agents.map((agent) => ({
    agent,
    ...(moods.get(agent.id) ?? { mood: "idle" as const }),
    stats: statsById.get(agent.id),
  }));
  const is = {
    working: (r: Row) => BUSY_MOODS.has(r.mood),
    needs: (r: Row) => r.mood === "error",
    paused: (r: Row) => r.agent.status === "paused",
  };
  const counts = {
    all: rows.length,
    working: rows.filter(is.working).length,
    needs: rows.filter(is.needs).length,
    paused: rows.filter(is.paused).length,
  };
  const needle = (search.q ?? "").toLowerCase();
  const sort = search.sort ?? "recent";
  const lastActive = (r: Row) => r.run?.createdAt ?? r.agent.createdAt;
  const shown = rows
    .filter((r) => !search.filter || is[search.filter](r))
    .filter(
      (r) =>
        !needle ||
        r.agent.name.toLowerCase().includes(needle) ||
        r.agent.spec.job.toLowerCase().includes(needle),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.agent.name.localeCompare(b.agent.name)
        : sort === "newest"
          ? b.agent.createdAt.localeCompare(a.agent.createdAt)
          : // Recent activity, with anyone who needs you or is busy first.
            Number(is.needs(b)) - Number(is.needs(a)) ||
            Number(is.working(b)) - Number(is.working(a)) ||
            lastActive(b).localeCompare(lastActive(a)),
    );

  const filterLabel: Record<Filter, string> = {
    all: "All",
    working: `Working ${counts.working}`,
    needs: `Needs you ${counts.needs}`,
    paused: `Paused ${counts.paused}`,
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h2 className="text-[40px] leading-[0.95] font-extrabold tracking-[-0.04em] md:text-[48px]">
          Agents <span className="text-muted-foreground/60">{agents.length}</span>
        </h2>
        <Link
          to="/agents/new"
          className="flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[15px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-[18px]" aria-hidden /> Hatch an agent
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-2.5">
        <label className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
          <span className="sr-only">Search agents</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={search.q ?? ""}
            onChange={(e) => setSearch({ q: e.target.value || undefined })}
            placeholder="Search by name or job"
            className="h-10 w-full rounded-full border border-input bg-card pr-3 pl-9.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring/60"
          />
        </label>
        <div
          role="group"
          aria-label="Show"
          className="flex gap-1 overflow-x-auto rounded-full border p-1 [scrollbar-width:none]"
        >
          {FILTERS.map((f) => {
            const current = (search.filter ?? "all") === f;
            return (
              <button
                key={f}
                type="button"
                aria-pressed={current}
                onClick={() => setSearch({ filter: f === "all" ? undefined : f })}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  current
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f === "needs" && counts.needs > 0 && (
                  <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                )}
                {filterLabel[f]}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sort}
              onChange={(e) =>
                setSearch({
                  sort:
                    e.target.value === "recent"
                      ? undefined
                      : (e.target.value as Sort as AgentsSearch["sort"]),
                })
              }
              className="h-10 rounded-full border border-input bg-card px-3 text-[13px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {Object.entries(SORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div role="group" aria-label="View" className="flex gap-1 rounded-full border p-1">
            {[
              { value: false, label: "Cards", icon: LayoutGrid },
              { value: true, label: "List", icon: List },
            ].map(({ value, label, icon: Icon }) => (
              <button
                key={label}
                type="button"
                aria-pressed={list === value}
                aria-label={label}
                title={label}
                onClick={() => setList(value)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  list === value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            ))}
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground">
          No agent matches.{" "}
          <button
            type="button"
            onClick={() => setSearch({ q: undefined, filter: undefined })}
            className="font-semibold text-foreground underline-offset-2 hover:underline"
          >
            Show all
          </button>
        </p>
      ) : list ? (
        <AgentTable rows={shown} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((row) => (
            <AgentCard key={row.agent.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentsSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading agents">
      <div className="skeleton h-12 w-48" />
      <div className="skeleton h-10 w-full max-w-[560px] rounded-full" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-[188px] rounded-[20px]" />
        ))}
      </div>
    </div>
  );
}

// ── What it is doing, and what to do about it ───────────────────────────────

function StatusWord({ row, now }: { row: Row; now: number }) {
  const { agent, mood, run } = row;
  const paused = agent.status === "paused";
  const word = paused
    ? "Paused"
    : mood === "error"
      ? "Stuck"
      : mood === "idle"
        ? "Idle"
        : MOOD_LABELS[mood];
  const busy = !paused && BUSY_MOODS.has(mood);
  return (
    <span
      className={cn(
        "eyebrow inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[10.5px] whitespace-nowrap",
        paused || mood === "idle" || mood === "asleep"
          ? "bg-accent text-muted-foreground"
          : mood === "error"
            ? "bg-destructive-surface text-destructive"
            : mood === "waiting"
              ? "bg-warning/15 text-warning"
              : "bg-primary/15 text-highlight",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full bg-current", busy && "animate-pulse")}
      />
      {word}
      {busy && run && (
        <span className="opacity-80">
          · {duration(now - Date.parse(run.startedAt ?? run.createdAt))}
        </span>
      )}
    </span>
  );
}

/** The phase of a working agent, from its run log. */
function LivePhase({ run }: { run: Run }) {
  const { events } = useRun(run.id);
  const phase = runPhase(run.status, events.data ?? []);
  return (
    <span className="shimmer-text">
      {phase.label}
      {phase.detail ? ` · ${phase.detail}` : ""}
    </span>
  );
}

function LiveLine({ row }: { row: Row }) {
  const { agent, mood, run, stats } = row;
  if (agent.status === "paused") return <>Paused, so it won't reply or run routines.</>;
  if (run && BUSY_MOODS.has(mood)) return <LivePhase run={run} />;
  if (mood === "error" && run) {
    return (
      <>
        {run.error?.message ?? "Its last run failed."} {timeAgo(run.endedAt ?? run.createdAt)}.
      </>
    );
  }
  const last = stats?.lastResult;
  if (last) {
    const title = (last.reply && leadingHeading(last.reply)) || last.request || "a finished run";
    return (
      <>
        Last result: <span className="text-foreground">{title}</span> ·{" "}
        {timeAgo(last.endedAt ?? last.createdAt)}
      </>
    );
  }
  return <>Hasn't run yet. Say hello.</>;
}

const ACTION =
  "relative z-10 flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

function QuickAction({ row }: { row: Row }) {
  const { agent, mood, run } = row;
  const navigate = useNavigate();
  const stop = useStopRun();
  const retry = useRetryRun();
  const update = useUpdateAgent(agent.id);
  const fail = (e: Error) => toast({ message: e.message, tone: "error" });

  if (agent.status === "paused") {
    return (
      <button
        type="button"
        disabled={update.isPending}
        onClick={() =>
          update.mutate(
            { status: "active" },
            {
              onSuccess: () =>
                toast({
                  message: `${agent.name} resumed`,
                  action: { label: "Undo", onClick: () => update.mutate({ status: "paused" }) },
                }),
              onError: fail,
            },
          )
        }
        className={cn(ACTION, "bg-primary text-primary-foreground hover:bg-primary/85")}
      >
        <Play className="size-3.5" aria-hidden /> Resume
      </button>
    );
  }
  if (run && BUSY_MOODS.has(mood)) {
    return (
      <button
        type="button"
        disabled={stop.isPending}
        aria-label={`Stop ${agent.name}`}
        onClick={() =>
          stop.mutate(run.id, { onSuccess: () => toast(`Stopping ${agent.name}`), onError: fail })
        }
        className={cn(ACTION, "border border-input hover:bg-accent")}
      >
        <Square className="size-3 fill-current" aria-hidden /> Stop
      </button>
    );
  }
  if (mood === "error" && run?.trigger === "message") {
    return (
      <button
        type="button"
        disabled={retry.isPending}
        onClick={() =>
          retry.mutate(run.id, {
            onSuccess: ({ message }) =>
              void navigate({
                to: "/agents/$agentId",
                params: { agentId: agent.id },
                search: { thread: message.threadId },
              }),
            onError: fail,
          })
        }
        className={cn(ACTION, "bg-primary text-primary-foreground hover:bg-primary/85")}
      >
        <RotateCcw className="size-3.5" aria-hidden /> Try again
      </button>
    );
  }
  return (
    <Link
      to="/agents/$agentId"
      params={{ agentId: agent.id }}
      search={{}}
      className={cn(ACTION, "border border-input hover:bg-accent")}
    >
      Message
    </Link>
  );
}

function AgentCard({ row }: { row: Row }) {
  const { agent, mood } = row;
  const busy = BUSY_MOODS.has(mood);
  const now = useNow(busy);
  const tools = toolWords(agent);
  return (
    <li
      className={cn(
        "relative flex min-w-0 flex-col gap-3 rounded-[20px] border bg-card px-4 pt-4 pb-3.5 transition-colors focus-within:border-input hover:border-input",
        mood === "error" && "border-destructive/40",
      )}
    >
      <div className="flex items-start gap-3.5">
        <Familiar
          look={agent.spec.avatar}
          mood={agent.status === "paused" ? "asleep" : mood}
          size={60}
          animate={shouldAnimate(mood)}
          ring="var(--card)"
          label={`${agent.name}'s familiar, ${MOOD_LABELS[mood].toLowerCase()}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            {/* The name's link covers the card; the action sits above it. */}
            <Link
              to="/agents/$agentId"
              params={{ agentId: agent.id }}
              search={{}}
              className="min-w-0 truncate text-[20px] leading-tight font-bold tracking-[-0.015em] outline-none after:absolute after:inset-0 after:rounded-[20px] focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {agent.name}
            </Link>
            <StatusWord row={row} now={now} />
          </div>
          <p className="truncate text-[13px] text-muted-foreground">{agent.spec.job}</p>
        </div>
      </div>
      <p className="line-clamp-2 min-h-[2.6em] text-[13.5px] leading-snug text-muted-foreground">
        <LiveLine row={row} />
      </p>
      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">
          {[...tools, `${TIER_INFO[agent.spec.modelTier].label} tier`].join(" · ")}
        </span>
        <QuickAction row={row} />
      </div>
    </li>
  );
}

function AgentTable({ rows }: { rows: readonly Row[] }) {
  const now = useNow(rows.some((r) => BUSY_MOODS.has(r.mood)));
  return (
    <div className="overflow-x-auto rounded-[20px] border bg-card">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="eyebrow px-4 py-3 text-[10.5px] font-normal">
              Agent
            </th>
            <th scope="col" className="eyebrow px-3 py-3 text-[10.5px] font-normal">
              Now
            </th>
            <th scope="col" className="eyebrow px-3 py-3 text-[10.5px] font-normal">
              Last run
            </th>
            <th scope="col" className="eyebrow px-3 py-3 text-right text-[10.5px] font-normal">
              This week
            </th>
            <th scope="col" className="px-4 py-3">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agent.id} className="border-b last:border-b-0">
              <td className="px-4 py-2.5">
                <Link
                  to="/agents/$agentId"
                  params={{ agentId: row.agent.id }}
                  search={{}}
                  className="flex items-center gap-3 rounded-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Familiar
                    look={row.agent.spec.avatar}
                    mood={row.agent.status === "paused" ? "asleep" : row.mood}
                    size={32}
                    ring="var(--card)"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">{row.agent.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {row.agent.spec.job}
                    </span>
                  </span>
                </Link>
              </td>
              <td className="px-3 py-2.5">
                <StatusWord row={row} now={now} />
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                {row.run ? timeAgo(row.run.createdAt) : "Never"}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-xs">
                {row.stats?.runsThisWeek ?? 0} {row.stats?.runsThisWeek === 1 ? "run" : "runs"}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex justify-end">
                  <QuickAction row={row} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
