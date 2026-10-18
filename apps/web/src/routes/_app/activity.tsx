import { moodFor, useAgents, useApiClient, useRun, useRunSearch, useStopRun } from "@ofa/client";
import type { Agent, Run, RunEvent, RunStatus } from "@ofa/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Info,
  Search,
  Square,
  X,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { ComingSoon } from "@/components/coming-soon";
import { Familiar } from "@/components/familiar";
import { Select } from "@/components/ui/select";
import { ErrorAlert } from "@/components/ui/alert";
import { shouldAnimate } from "@/lib/agents";
import { HOUSEHOLD } from "@/lib/familiars";
import { clockTime, count, dayLabel, duration, shortTime } from "@/lib/format";
import { timeline, type TimelineItem } from "@/lib/timeline";
import { useNow, useVisible } from "@/lib/use-now";
import { cn } from "@/lib/utils";

// Activity (UX.10): every run, grouped by day and filterable, each saying
// what was asked. A run opens summary first (asked, answered, totals), then
// grouped steps; the raw log is one toggle away (ADR-0014).

const FILTERS = {
  all: { label: "All", statuses: undefined },
  running: { label: "Running", statuses: ["queued", "running", "waiting"] },
  failed: { label: "Failed", statuses: ["failed"] },
  stopped: { label: "Stopped", statuses: ["cancelled"] },
  done: { label: "Done", statuses: ["succeeded"] },
} as const satisfies Record<string, { label: string; statuses: readonly RunStatus[] | undefined }>;
type FilterKey = keyof typeof FILTERS;

interface ActivitySearch {
  run?: string;
  agent?: string;
  status?: FilterKey;
  q?: string;
}

export const Route = createFileRoute("/_app/activity")({
  staticData: { title: "Activity", fullBleed: true },
  validateSearch: (search: Record<string, unknown>): ActivitySearch => {
    const out: ActivitySearch = {};
    if (typeof search.run === "string") out.run = search.run;
    if (typeof search.agent === "string") out.agent = search.agent;
    if (typeof search.status === "string" && search.status in FILTERS && search.status !== "all") {
      out.status = search.status as FilterKey;
    }
    if (typeof search.q === "string" && search.q.trim()) out.q = search.q.trim().slice(0, 200);
    return out;
  },
  component: ActivityPage,
});

const ACTIVE = new Set(["queued", "running", "waiting"]);

const STATUS: Record<Run["status"], { word: string; className: string; icon: React.ReactNode }> = {
  queued: {
    word: "Queued",
    className: "text-primary",
    icon: <span className="size-1.5 animate-pulse rounded-full bg-current" />,
  },
  running: {
    word: "Running",
    className: "text-highlight",
    icon: <span className="size-1.5 animate-pulse rounded-full bg-current" />,
  },
  waiting: {
    word: "Waiting",
    className: "text-warning",
    icon: <span className="size-1.5 rotate-45 bg-current" />,
  },
  succeeded: {
    word: "Done",
    className: "text-success",
    icon: <Check className="size-3" strokeWidth={3} />,
  },
  failed: {
    word: "Failed",
    className: "text-destructive",
    icon: <X className="size-3" strokeWidth={3} />,
  },
  cancelled: {
    word: "Stopped",
    className: "text-muted-foreground",
    icon: <Square className="size-2.5 fill-current" />,
  },
};

function StatusWord({ status, className }: { status: Run["status"]; className?: string }) {
  const s = STATUS[status];
  return (
    <span
      className={cn(
        "eyebrow inline-flex items-center gap-1.5 text-[10.5px] whitespace-nowrap",
        s.className,
        className,
      )}
    >
      <span aria-hidden className="flex items-center">
        {s.icon}
      </span>
      {s.word}
    </span>
  );
}

const TRIGGERS: Record<Run["trigger"], string> = {
  message: "Chat",
  routine: "Routine",
  delegation: "Asked by another agent",
  event: "Messaged by another agent",
  manual: "Routine test run",
  schedule: "Task it set for later",
};

function ActivityPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: agents } = useAgents();
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const filter = FILTERS[search.status ?? "all"];
  const runs = useRunSearch({
    agentId: search.agent,
    status: filter.statuses,
    q: search.q,
  });
  const items = runs.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(search.agent || search.status || search.q);
  const selected =
    search.run ??
    (typeof window !== "undefined" && window.innerWidth >= 1024 ? items[0]?.id : undefined);
  const setSearch = (patch: Partial<ActivitySearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  if (runs.error) {
    return (
      <div className="p-6">
        <ErrorAlert>Couldn't load activity: {runs.error.message}</ErrorAlert>
      </div>
    );
  }
  if (!runs.isPending && items.length === 0 && !filtered) {
    return (
      <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
        <ComingSoon
          familiar={HOUSEHOLD.ledger}
          mood="asleep"
          heading="Nothing has run yet"
          badge="Activity"
        >
          Every run an agent makes shows up here, step by step: what it searched, what it read and
          what it decided.
        </ComingSoon>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Filters search={search} agents={agents ?? []} onChange={setSearch} />
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(340px,440px)_minmax(0,1fr)]">
        <div className={cn("min-h-0 overflow-y-auto border-r", search.run && "hidden lg:block")}>
          <RunList
            runs={items}
            agents={byId}
            selected={selected}
            loading={runs.isPending}
            filtered={filtered}
            hasMore={!!runs.hasNextPage}
            loadingMore={runs.isFetchingNextPage}
            onMore={() => void runs.fetchNextPage()}
            onClear={() => setSearch({ agent: undefined, status: undefined, q: undefined })}
          />
        </div>
        <div className={cn("min-h-0 overflow-y-auto", !search.run && "hidden lg:block")}>
          {selected ? (
            <RunDetail
              key={selected}
              runId={selected}
              agents={byId}
              onBack={() => setSearch({ run: undefined })}
            />
          ) : (
            <p className="p-8 text-sm text-muted-foreground">Pick a run to see what happened.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Filters({
  search,
  agents,
  onChange,
}: {
  search: ActivitySearch;
  agents: readonly Agent[];
  onChange: (patch: Partial<ActivitySearch>) => void;
}) {
  const [text, setText] = useState(search.q ?? "");
  // Search as you type, a moment after the last key.
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((search.q ?? "") !== text.trim())
        onChange({ q: text.trim() || undefined, run: undefined });
    }, 300);
    return () => clearTimeout(timer);
  }, [text, search.q, onChange]);

  const active = search.status ?? "all";
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-3.5 md:px-7">
      <h1 className="text-[26px] leading-none font-extrabold tracking-[-0.025em] md:text-[28px]">
        Activity
      </h1>
      <label className="flex h-10 w-full items-center gap-2.5 rounded-full border border-input bg-card px-3.5 text-muted-foreground focus-within:border-ring/60 sm:w-64">
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="sr-only">Search what was asked</span>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search what was asked"
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <div
        role="group"
        aria-label="Status"
        className="flex gap-0.5 overflow-x-auto rounded-full border p-1"
      >
        {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            onClick={() => onChange({ status: key === "all" ? undefined : key, run: undefined })}
            className={cn(
              "h-8 shrink-0 rounded-full px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active === key
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {FILTERS[key].label}
          </button>
        ))}
      </div>
      <label className="flex h-10 items-center">
        <span className="sr-only">Agent</span>
        <Select
          variant="pill"
          value={search.agent ?? ""}
          onChange={(e) => onChange({ agent: e.target.value || undefined, run: undefined })}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </label>
    </header>
  );
}

function RunList(props: {
  runs: readonly Run[];
  agents: Map<string, Agent>;
  selected: string | undefined;
  loading: boolean;
  filtered: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onClear: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const atEnd = useVisible(end);
  const { hasMore, loadingMore, onMore } = props;
  // Load the next page while the end of the list is in view.
  useEffect(() => {
    if (atEnd && hasMore && !loadingMore) onMore();
  }, [atEnd, hasMore, loadingMore, onMore]);

  if (props.loading) {
    return (
      <div className="flex flex-col gap-2 p-3" aria-busy="true" aria-label="Loading runs">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            <div className="skeleton size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="skeleton h-3.5 w-4/5" />
              <div className="skeleton h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (props.runs.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 p-6 text-sm text-muted-foreground">
        No runs match these filters.
        {props.filtered && (
          <button
            type="button"
            onClick={props.onClear}
            className="font-semibold text-highlight underline-offset-2 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>
    );
  }

  return (
    <nav aria-label="Runs" className="flex flex-col px-2 pt-1 pb-6">
      {props.runs.map((run, i) => {
        const agent = props.agents.get(run.agentId);
        const day = dayLabel(run.createdAt);
        const before = props.runs[i - 1];
        const header = !before || dayLabel(before.createdAt) !== day ? day : null;
        const took =
          run.startedAt && run.endedAt
            ? duration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
            : null;
        const live = ACTIVE.has(run.status);
        return (
          <Fragment key={run.id}>
            {header && (
              <h2 className="eyebrow px-3 pt-4 pb-1.5 font-sans text-[10.5px] text-muted-foreground">
                {header}
              </h2>
            )}
            <Link
              to="/activity"
              search={(prev) => ({ ...prev, run: run.id })}
              aria-current={run.id === props.selected ? "true" : undefined}
              className={cn(
                "grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] px-3 py-2.5 outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring",
                run.id === props.selected && "bg-card ring-1 ring-input",
              )}
            >
              {agent ? (
                <Familiar
                  look={agent.spec.avatar}
                  mood={moodFor({ agentStatus: "active", run })}
                  size={32}
                  ring="var(--background)"
                  animate={live && shouldAnimate("working")}
                />
              ) : (
                <span className="size-8 rounded-full bg-accent" />
              )}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={cn(
                    "truncate text-[14px]",
                    run.id === props.selected && "font-semibold",
                  )}
                >
                  {run.request ?? TRIGGERS[run.trigger]}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {agent?.name ?? "Agent"} · {shortTime(run.createdAt)}
                  {took ? ` · ${took}` : ""}
                  {run.usage.toolCalls ? ` · ${count(run.usage.toolCalls, "step")}` : ""}
                </span>
              </span>
              <StatusWord status={run.status} />
            </Link>
          </Fragment>
        );
      })}
      <div ref={end} className="px-3 pt-3">
        {props.loadingMore ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading more runs">
            <div className="skeleton h-14 w-full rounded-[12px]" />
            <div className="skeleton h-14 w-full rounded-[12px]" />
          </div>
        ) : (
          props.hasMore && (
            <button
              type="button"
              onClick={props.onMore}
              className="h-10 w-full rounded-[12px] border border-dashed text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Show more
            </button>
          )
        )}
      </div>
    </nav>
  );
}

function RunDetail({
  runId,
  agents,
  onBack,
}: {
  runId: string;
  agents: Map<string, Agent>;
  onBack: () => void;
}) {
  const { run, events } = useRun(runId);
  const stop = useStopRun();
  const [raw, setRaw] = useState(false);
  const r = run.data;
  const active = !!r && ACTIVE.has(r.status);
  const now = useNow(active);

  if (run.error) {
    return (
      <div className="p-6">
        <ErrorAlert>{run.error.message}</ErrorAlert>
      </div>
    );
  }
  if (!r) {
    return (
      <div className="flex flex-col gap-4 p-7" aria-busy="true">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-8 w-3/4" />
        <div className="skeleton h-20 w-full" />
      </div>
    );
  }
  const agent = agents.get(r.agentId);
  const list = events.data ?? [];
  const steps = timeline(list);
  const took = r.startedAt
    ? duration((r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt))
    : "–";
  const tokens = r.usage.inputTokens + r.usage.outputTokens;
  const failedTools = list.filter((e) => e.type === "tool.failed").length;

  return (
    <section aria-label="Run" className="flex flex-col gap-5 px-4 py-5 md:px-7 md:py-6">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 self-start text-sm text-muted-foreground lg:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> All runs
      </button>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <StatusWord status={r.status} className="rounded-full bg-accent px-2.5 py-1" />
            <span className="font-mono text-xs text-muted-foreground">
              {dayLabel(r.createdAt)} {shortTime(r.createdAt)} · {agent?.name ?? "Agent"} ·{" "}
              {TRIGGERS[r.trigger].toLowerCase()}
            </span>
          </div>
          <h2 className="text-[24px] leading-tight font-extrabold tracking-[-0.025em] md:text-[28px]">
            {r.request ?? `${TRIGGERS[r.trigger]} run`}
          </h2>
        </div>
        <div className="flex shrink-0 gap-2">
          {agent && (
            <Link
              to="/agents/$agentId"
              params={{ agentId: agent.id }}
              className="flex h-9 items-center rounded-full border border-input px-4 text-[13px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open chat
            </Link>
          )}
          {active && (
            <button
              type="button"
              onClick={() => stop.mutate(r.id)}
              disabled={stop.isPending}
              className="flex h-9 items-center gap-2 rounded-full border border-input px-4 text-[13px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <Square className="size-3 fill-current" aria-hidden /> Stop
            </button>
          )}
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
        {[
          ["Took", took],
          ["Model calls", String(r.usage.modelCalls)],
          ["Tool calls", `${r.usage.toolCalls}${failedTools ? ` · ${failedTools} failed` : ""}`],
          ["Tokens", tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)],
          ["Cost", r.usage.costUsd > 0 ? `$${r.usage.costUsd.toFixed(4)}` : "Free"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-1 rounded-[14px] border bg-card px-3.5 py-3"
          >
            <dt className="eyebrow text-[10px] text-muted-foreground">{label}</dt>
            <dd className="font-display text-[20px] leading-none font-extrabold tracking-[-0.02em]">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {(r.request || r.reply) && (
        <div className="grid gap-3 md:grid-cols-2">
          {r.request && (
            <div className="flex flex-col gap-1.5 rounded-[16px] border bg-card px-4 py-3.5">
              <span className="eyebrow text-[10px] text-muted-foreground">You asked</span>
              <p className="text-[14.5px] leading-relaxed">{r.request}</p>
            </div>
          )}
          <div className="flex flex-col gap-1.5 rounded-[16px] border bg-card px-4 py-3.5">
            <span className="eyebrow text-[10px] text-muted-foreground">
              {agent?.name ?? "The agent"} answered
            </span>
            {r.reply ? (
              <>
                <p className="line-clamp-3 text-[14.5px] leading-relaxed text-muted-foreground">
                  {r.reply.replace(/[#*_`>|]/g, "").trim()}
                </p>
                {agent && (
                  <Link
                    to="/agents/$agentId"
                    params={{ agentId: agent.id }}
                    className="self-start text-[13px] font-semibold text-highlight underline-offset-2 hover:underline"
                  >
                    Read the reply →
                  </Link>
                )}
              </>
            ) : (
              <p className="text-[14px] text-muted-foreground">
                {active ? "Still working…" : "No reply."}
              </p>
            )}
          </div>
        </div>
      )}

      {r.error && <ErrorAlert>{r.error.message}</ErrorAlert>}

      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-3 pb-2">
          <h3 className="text-[18px] font-bold">What happened</h3>
          <div role="group" aria-label="View" className="flex gap-0.5 rounded-full border p-1">
            {[
              [false, "Steps"],
              [true, `Full log · ${list.length}`],
            ].map(([value, label]) => (
              <button
                key={String(value)}
                type="button"
                aria-pressed={raw === value}
                onClick={() => setRaw(value as boolean)}
                className={cn(
                  "h-7 rounded-full px-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  raw === value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label as string}
              </button>
            ))}
          </div>
        </div>
        {raw ? <RawLog events={list} /> : <Steps items={steps.items} />}
        {!raw && steps.hiddenChecks > 0 && (
          <p className="mt-2 pl-10 text-[12.5px] text-muted-foreground">
            {count(steps.hiddenChecks, "policy check")} allowed a call without asking and{" "}
            {steps.hiddenChecks === 1 ? "is" : "are"} hidden. Checks that ask or refuse always show.
          </p>
        )}
      </div>
    </section>
  );
}

function StepDot({ state }: { state: TimelineItem["state"] }) {
  const base = "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full";
  if (state === "done")
    return (
      <span className={cn(base, "bg-primary text-primary-foreground")}>
        <Check className="size-3" strokeWidth={3.2} aria-label="Done" />
      </span>
    );
  if (state === "failed")
    return (
      <span className={cn(base, "bg-destructive-surface text-destructive")}>
        <X className="size-3" strokeWidth={3.2} aria-label="Failed" />
      </span>
    );
  if (state === "warn")
    return (
      <span className={cn(base, "bg-warning/15 text-warning ring-1 ring-warning/30")}>
        <AlertTriangle className="size-3" strokeWidth={2.6} aria-label="Notice" />
      </span>
    );
  if (state === "active")
    return (
      <span className={cn(base, "border-2 border-primary bg-background")} aria-label="In progress">
        <span className="size-2 animate-pulse rounded-full bg-primary" />
      </span>
    );
  return (
    <span className={cn(base, "bg-accent text-muted-foreground")}>
      <Info className="size-3" strokeWidth={2.6} aria-label="Note" />
    </span>
  );
}

function Steps({ items }: { items: readonly TimelineItem[] }) {
  if (items.length === 0) return <p className="py-3 text-sm text-muted-foreground">Nothing yet.</p>;
  return (
    <ol className="relative">
      <span aria-hidden className="absolute top-4 bottom-4 left-[11px] w-0.5 bg-border" />
      {items.map((item) => (
        <StepRow key={item.id} item={item} />
      ))}
    </ol>
  );
}

function StepRow({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(
    item.state === "failed" || (item.children?.some((c) => c.state === "failed") ?? false),
  );
  return (
    <li className="grid grid-cols-[24px_minmax(0,1fr)_auto] gap-x-4 py-2.5">
      <StepDot state={item.state} />
      <div className="flex min-w-0 flex-col gap-0.5">
        {item.children ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1.5 self-start text-left text-[14.5px] font-semibold outline-none focus-visible:underline"
          >
            {item.title}
            {open ? (
              <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
            )}
          </button>
        ) : (
          <span
            className={cn("text-[14.5px] font-semibold", item.state === "warn" && "text-warning")}
          >
            {item.title}
          </span>
        )}
        {item.detail && (
          <span className="text-[13px] break-words text-muted-foreground">{item.detail}</span>
        )}
        {item.children && open && (
          <ul className="mt-2 flex flex-col rounded-[12px] border bg-card p-1">
            {item.children.map((child, i) => (
              <li
                key={i}
                className={cn(
                  "grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 text-[13px]",
                  child.state === "failed" && "bg-destructive-surface/50",
                )}
              >
                {child.state === "failed" ? (
                  <CircleSlash className="size-3.5 text-destructive" aria-label="Failed" />
                ) : child.state === "active" ? (
                  <span
                    className="size-2 animate-pulse justify-self-center rounded-full bg-primary"
                    aria-label="Reading"
                  />
                ) : (
                  <Check className="size-3.5 text-success" aria-label="Read" />
                )}
                <span className="truncate">{child.label}</span>
                {child.detail && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {child.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="pt-0.5 font-mono text-[11px] text-muted-foreground">
        {shortTime(item.at)}
      </span>
    </li>
  );
}

// ── The raw log ──────────────────────────────────────────────────────────────

function RawLog({ events }: { events: readonly RunEvent[] }) {
  return (
    <ol className="flex flex-col">
      {events.map((event) => (
        <li
          key={event.seq}
          className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 border-t py-2.5 text-sm"
        >
          <span className="font-mono text-xs text-muted-foreground">
            {clockTime(event.createdAt)}
          </span>
          <EventLine event={event} />
        </li>
      ))}
    </ol>
  );
}

/** Download the full output or file a step kept (M3.06). */
function ArtifactLink({ id }: { id: string }) {
  const api = useApiClient();
  return (
    <a
      href={api.artifactContentUrl(id)}
      className="mt-1 inline-flex text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      Download what it kept
    </a>
  );
}

function EventLine({ event }: { event: RunEvent }) {
  const title = (text: string, tone?: "bad" | "warn" | "good") => (
    <span
      className={cn(
        "font-semibold",
        tone === "bad" && "text-destructive",
        tone === "warn" && "text-warning",
        tone === "good" && "text-highlight",
      )}
    >
      {text}
    </span>
  );
  const note = (text: string) => (
    <span className="block truncate font-mono text-xs text-muted-foreground">{text}</span>
  );

  switch (event.type) {
    case "run.started":
      return (
        <div>
          {title("Started")} {note(`${event.payload.trigger} · ${event.payload.tier} tier`)}
        </div>
      );
    case "model.called":
      return (
        <div>
          {title(
            event.payload.promptVersion?.startsWith("memory.extract")
              ? "Looked back for things to remember"
              : "Model answered",
          )}
          {note(
            `${event.payload.model} · ${event.payload.inputTokens}→${event.payload.outputTokens} tokens · ${duration(event.payload.durationMs)}` +
              (event.payload.toolCalls ? ` · ${count(event.payload.toolCalls, "tool call")}` : "") +
              (event.payload.fellBackFrom
                ? ` · after ${event.payload.fellBackFrom.length} failed`
                : ""),
          )}
        </div>
      );
    case "model.failed":
      return (
        <div>
          {title(`Model failed (${event.payload.code})`, "warn")}{" "}
          {note(`${event.payload.model}: ${event.payload.message}`)}
        </div>
      );
    case "policy.decided":
      return (
        <div>
          {title(
            `Policy: ${event.payload.verdict}`,
            event.payload.verdict === "auto" ? undefined : "warn",
          )}{" "}
          {note(`${event.payload.tool} · ${event.payload.reasons.join("; ")}`)}
        </div>
      );
    case "tool.called":
      return (
        <div>
          {title(`Called ${event.payload.tool}`)} {note(JSON.stringify(event.payload.args))}
        </div>
      );
    case "tool.completed":
      return (
        <div>
          {title(`${event.payload.tool} returned`)} {note(event.payload.preview)}
          {event.payload.artifactId && <ArtifactLink id={event.payload.artifactId} />}
        </div>
      );
    case "tool.failed":
      return (
        <div>
          {title(`${event.payload.tool} failed`, "bad")} {note(event.payload.message)}
        </div>
      );
    case "run.tainted":
      return (
        <div>
          {title("Read outside content", "warn")}{" "}
          {note(`From ${event.payload.source}. Sending anything out now needs approval.`)}
        </div>
      );
    case "run.waiting":
      return (
        <div>
          {title("Waiting for model capacity", "warn")}{" "}
          {note(event.payload.until ? `Until about ${clockTime(event.payload.until)}` : "")}
        </div>
      );
    case "run.compacted":
      return (
        <div>
          {title("Summarised earlier steps")}{" "}
          {note(`${event.payload.tokensBefore} → ${event.payload.tokensAfter} tokens`)}
        </div>
      );
    case "message.created":
      return (
        <div>
          {title("Replied")} {note(event.payload.preview)}
        </div>
      );
    case "memory.written":
      return (
        <div>
          {title("Saved a memory")}{" "}
          {note(`${event.payload.scope}${event.payload.verified ? "" : " · unverified"}`)}
        </div>
      );
    case "run.ended":
      return (
        <div>
          {title(
            event.payload.status === "succeeded"
              ? "Finished"
              : event.payload.status === "cancelled"
                ? "Stopped"
                : "Failed",
            event.payload.status === "failed" ? "bad" : "good",
          )}{" "}
          {note(event.payload.stopReason.replaceAll("_", " "))}
        </div>
      );
    default:
      return <div>{title(event.type)}</div>;
  }
}
