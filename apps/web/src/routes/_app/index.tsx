import {
  useAgents,
  useAskAgent,
  useLlmSettings,
  useMemories,
  useRetryRun,
  useRun,
  useRuns,
  useStopRun,
  useUsageToday,
} from "@ofa/client";
import type { Agent, FamiliarMood, MemoryItem, Run } from "@ofa/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ArrowUp, KeyRound, RotateCcw, Square, X } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { WorkingRing } from "@/components/chat/live-run";
import { Familiar } from "@/components/familiar";
import { FactRow, useForgetWithUndo } from "@/components/memory-review";
import { Card, CardTitle } from "@/components/ui/card";
import { parseMention, starters, useAgentMoods } from "@/lib/agents";
import { count, duration, firstName, partOfDay, shortTime, timeAgo } from "@/lib/format";
import { leadingHeading, previewText } from "@/lib/markdown";
import { runPhase } from "@/lib/run-steps";
import { useStoredFlag } from "@/lib/shortcuts";
import { toast } from "@/lib/toast";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

// Home (UX.11): what needs you first, a box to ask any agent, who is working
// now, recent results, and the day's model quota. Health appears only as the
// shell's banner, when something is wrong.

export const Route = createFileRoute("/_app/")({
  staticData: { title: "Home" },
  component: HomePage,
});

const ACTIVE = new Set(["queued", "running", "waiting"]);

function HomePage() {
  const { session } = Route.useRouteContext();
  const { data: agents, isPending: loadingAgents } = useAgents();
  const { data: runs } = useRuns();
  const { data: llm } = useLlmSettings();
  const { data: unconfirmed } = useMemories({ verified: false });
  const moods = useAgentMoods(agents);
  const { hidden, forget } = useForgetWithUndo();
  const now = new Date();
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));

  const working = (runs ?? []).filter((r) => ACTIVE.has(r.status) && byId.has(r.agentId));
  const stuck = (agents ?? []).flatMap((a) => {
    const entry = moods.get(a.id);
    return entry?.mood === "error" && entry.run ? [{ agent: a, run: entry.run }] : [];
  });
  const facts = (unconfirmed ?? []).filter((m) => !hidden.has(m.id));
  const noKey = !!llm && !llm.key.configured;
  const needs = (noKey ? 1 : 0) + stuck.length + (facts.length ? groupFacts(facts).size : 0);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const results = (runs ?? []).filter((r) => r.status === "succeeded" && byId.has(r.agentId));
  const recentCount = results.filter(
    (r) => Date.parse(r.endedAt ?? r.createdAt) >= yesterday,
  ).length;

  const summary = [
    needs
      ? `${needs === 1 ? "One thing needs" : `${needs} things need`} you.`
      : "Nothing needs you.",
    working.length
      ? `${namesOf(working.map((r) => byId.get(r.agentId)?.name ?? ""))} ${working.length === 1 ? "is" : "are"} working.`
      : null,
    recentCount ? `${count(recentCount, "result")} since yesterday.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <span className="eyebrow text-[11px] text-muted-foreground">
          {now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
        </span>
        <h2 className="text-[38px] leading-[0.95] font-extrabold tracking-[-0.04em] md:text-[48px]">
          Good {partOfDay(now).toLowerCase()}, {firstName(session.user.name)}.
        </h2>
        {!loadingAgents && (agents?.length ?? 0) > 0 && (
          <p className="text-[15px] text-muted-foreground">{summary}</p>
        )}
      </header>

      <Setup
        hasKey={!!llm?.key.configured}
        hasAgent={(agents?.length ?? 0) > 0}
        loading={!llm || loadingAgents}
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]">
        <div className="flex flex-col gap-5">
          {(agents?.length ?? 0) > 0 && <AskBox agents={agents ?? []} />}

          {needs > 0 && (
            <section aria-labelledby="needs-you" className="flex flex-col gap-2.5">
              <SectionTitle id="needs-you" count={needs}>
                Needs you
              </SectionTitle>
              <ul className="flex flex-col gap-2.5">
                {noKey && (
                  <NeedItem
                    icon={<KeyRound className="size-5" aria-hidden />}
                    title="Add your model key"
                    body="Agents can't answer until there is a key. Free models work."
                    action={
                      <Link to="/settings" className={PRIMARY_SMALL}>
                        Add key
                      </Link>
                    }
                  />
                )}
                {stuck.map(({ agent, run }) => (
                  <StuckItem key={agent.id} agent={agent} run={run} />
                ))}
                {[...groupFacts(facts)].map(([agentId, list]) => {
                  const agent = byId.get(agentId);
                  return (
                    <li
                      key={agentId}
                      className="rounded-[18px] border border-primary/40 bg-card px-4 py-3.5"
                    >
                      <div className="flex items-start gap-3">
                        {agent && (
                          <Familiar look={agent.spec.avatar} size={36} ring="var(--card)" />
                        )}
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-[15px] font-semibold">
                            {agent?.name ?? "Your agents"} learned {count(list.length, "thing")}{" "}
                            from outside content
                          </span>
                          <span className="text-[13px] text-muted-foreground">
                            {agent?.name ?? "No agent"} won't use{" "}
                            {list.length === 1 ? "it" : "them"} until you keep{" "}
                            {list.length === 1 ? "it" : "them"}.
                          </span>
                        </div>
                      </div>
                      <ul className="mt-1 flex flex-col divide-y pl-[48px]">
                        {list.slice(0, 3).map((m) => (
                          <FactRow key={m.id} item={m} onForget={forget} compact />
                        ))}
                      </ul>
                      {agent && list.length > 3 && (
                        <Link
                          to="/agents/$agentId/memory"
                          params={{ agentId: agent.id }}
                          className="mt-1 ml-[48px] inline-flex text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          {list.length - 3} more in {agent.name}'s memory →
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {working.length > 0 && (
            <div className="lg:hidden">
              <WorkingNow runs={working} agents={byId} moods={moods} />
            </div>
          )}
          <RecentResults results={results.slice(0, 4)} agents={byId} />
        </div>

        <div className="flex flex-col gap-5">
          <div className={cn(working.length > 0 && "hidden lg:block")}>
            <WorkingNow runs={working} agents={byId} moods={moods} />
          </div>
          <QuotaCard />
        </div>
      </div>
    </div>
  );
}

const PRIMARY_SMALL =
  "flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring";
const OUTLINE_SMALL =
  "flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-input px-4 text-[13px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

function namesOf(names: readonly string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 2) return unique.join(" and ");
  return `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} more`;
}

function groupFacts(facts: readonly MemoryItem[]): Map<string, MemoryItem[]> {
  const groups = new Map<string, MemoryItem[]>();
  for (const m of facts) {
    const key = m.agentId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return groups;
}

function SectionTitle({
  id,
  count: n,
  children,
  link,
}: {
  id: string;
  count?: number;
  children: React.ReactNode;
  link?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-1">
      <h3 id={id} className="flex items-baseline gap-2 text-[17px] font-bold">
        {children}
        {n !== undefined && (
          <span className="font-mono text-[13px] text-muted-foreground">{n}</span>
        )}
      </h3>
      {link}
    </div>
  );
}

// ── Setup ────────────────────────────────────────────────────────────────────

/**
 * The checklist while something essential is missing; afterwards a chip,
 * which can be closed for good on this device.
 */
function Setup({
  hasKey,
  hasAgent,
  loading,
}: {
  hasKey: boolean;
  hasAgent: boolean;
  loading: boolean;
}) {
  const [dismissed, setDismissed] = useStoredFlag("ofa-setup-chip-hidden", false);
  if (loading) return null;
  const steps = [
    { title: "Create the owner account and workspace", done: true },
    { title: "Add your model key", done: hasKey, to: "/settings" as const },
    { title: "Hatch your first agent", done: hasAgent, to: "/agents/new" as const },
    { title: "Connect a channel", done: false, soon: true },
  ];
  const done = steps.filter((s) => s.done).length;

  if (hasKey && hasAgent) {
    if (dismissed) return null;
    return (
      <div className="flex items-center gap-2 self-start rounded-full border bg-card py-1 pr-1 pl-3.5 text-[13px] text-muted-foreground">
        <span>
          Setup {done} of {steps.length} · Connect a channel arrives soon
        </span>
        <button
          type="button"
          aria-label="Hide setup"
          onClick={() => setDismissed(true)}
          className="flex size-7 items-center justify-center rounded-full outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline justify-between px-5 pt-4 pb-3">
        <CardTitle>Get started</CardTitle>
        <span className="font-mono text-xs text-muted-foreground">
          {done} of {steps.length}
        </span>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.title} className="flex items-center gap-4 border-t px-5 py-3">
            <span className="w-4 font-mono text-[13px] text-muted-foreground">{index + 1}</span>
            <span
              className={cn(
                "flex-1 text-[15px] font-semibold",
                step.done && "text-muted-foreground line-through",
              )}
            >
              {step.title}
            </span>
            {step.done ? (
              <span className="eyebrow rounded-full bg-success px-2.5 py-1 text-[11px] text-background">
                Done
              </span>
            ) : step.to ? (
              <Link to={step.to} className={PRIMARY_SMALL}>
                Do it
              </Link>
            ) : (
              <span className="eyebrow rounded-full border px-2.5 py-[3px] text-[11px] text-muted-foreground">
                Soon
              </span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ── Ask an agent ─────────────────────────────────────────────────────────────

/**
 * Ask any agent from Home. "@name" at the start picks the agent; sending
 * opens its chat with the run already going.
 */
function AskBox({ agents }: { agents: readonly Agent[] }) {
  const navigate = useNavigate();
  const ask = useAskAgent();
  const active = agents.filter((a) => a.status === "active");
  const [agentId, setAgentId] = useState(active[0]?.id ?? agents[0]?.id ?? "");
  const [text, setText] = useState("");
  const mention = parseMention(text, agents);
  const agent = mention?.agent ?? agents.find((a) => a.id === agentId) ?? agents[0];
  if (!agent) return null;
  const content = (mention ? mention.rest : text).trim();
  const paused = agent.status !== "active";

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!content || ask.isPending || paused) return;
    ask.mutate(
      { agentId: agent.id, content },
      {
        onSuccess: () => {
          setText("");
          void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
        },
        onError: (e) => toast({ message: e.message, tone: "error" }),
      },
    );
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <Card className="flex flex-col gap-3 px-4 pt-4 pb-3.5 sm:px-5">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="ask-agent" className="text-[17px] font-bold">
            Ask an agent
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">Agent</span>
            <Familiar look={agent.spec.avatar} size={26} ring="var(--card)" />
            <select
              value={agent.id}
              onChange={(e) => {
                setAgentId(e.target.value);
                if (mention) setText(mention.rest);
              }}
              className="h-9 max-w-[160px] rounded-full border border-input bg-card px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.status !== "active" ? " (paused)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-end gap-2 rounded-[22px] border border-input bg-background p-1.5 pl-4 focus-within:border-ring/60">
          <textarea
            id="ask-agent"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={paused}
            placeholder={
              paused
                ? `${agent.name} is paused. Resume it from its chat.`
                : `Ask ${agent.name}, or type @ and a name`
            }
            className="max-h-40 min-h-12 flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <button
            type="submit"
            aria-label={`Send to ${agent.name}`}
            disabled={!content || ask.isPending || paused}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:bg-accent disabled:text-muted-foreground"
          >
            <ArrowUp className="size-5" aria-hidden />
          </button>
        </div>
      </form>
      {!paused && (
        <div className="flex flex-wrap gap-1.5">
          {starters(agent).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setText(s)}
              className="flex min-h-9 items-center rounded-full border px-3 text-left text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Needs you ────────────────────────────────────────────────────────────────

function NeedItem(props: {
  icon: React.ReactNode;
  title: string;
  body: string;
  meta?: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-[18px] border border-primary/40 bg-card px-4 py-3.5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center">{props.icon}</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{props.title}</span>
          <span className="text-[13px] text-muted-foreground">{props.body}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
        {props.meta && (
          <span className="font-mono text-xs text-muted-foreground">{props.meta}</span>
        )}
        {props.action}
      </div>
    </li>
  );
}

function StuckItem({ agent, run }: { agent: Agent; run: Run }) {
  const retry = useRetryRun();
  const navigate = useNavigate();
  return (
    <NeedItem
      icon={<Familiar look={agent.spec.avatar} mood="error" size={36} animate ring="var(--card)" />}
      title={`${agent.name} is stuck`}
      body={`${run.error?.message ?? "Its last run failed."} Nothing was sent or changed.`}
      meta={timeAgo(run.endedAt ?? run.createdAt)}
      action={
        <>
          <Link to="/activity" search={{ run: run.id }} className={OUTLINE_SMALL}>
            Details
          </Link>
          {run.trigger === "message" && agent.status === "active" && (
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
                  onError: (e) => toast({ message: e.message, tone: "error" }),
                })
              }
              className={PRIMARY_SMALL}
            >
              <RotateCcw className="size-3.5" aria-hidden /> Try again
            </button>
          )}
        </>
      }
    />
  );
}

// ── Recent results ───────────────────────────────────────────────────────────

function RecentResults({
  results,
  agents,
}: {
  results: readonly Run[];
  agents: Map<string, Agent>;
}) {
  return (
    <section aria-labelledby="recent-results" className="flex flex-col gap-2.5">
      <SectionTitle
        id="recent-results"
        link={
          <Link
            to="/activity"
            search={{ status: "done" }}
            className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            All activity <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        }
      >
        Recent results
      </SectionTitle>
      {results.length === 0 ? (
        <p className="rounded-[18px] border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Finished answers show up here.
        </p>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {results.map((run) => {
            const agent = agents.get(run.agentId);
            const title =
              (run.reply && leadingHeading(run.reply)) || run.request || "A finished run";
            const body = run.reply ? previewText(run.reply) : "";
            const took =
              run.startedAt && run.endedAt
                ? duration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
                : null;
            return (
              <li key={run.id}>
                <Link
                  to="/agents/$agentId"
                  params={{ agentId: run.agentId }}
                  search={run.threadId ? { thread: run.threadId } : {}}
                  className="flex h-full flex-col gap-1.5 rounded-[18px] border bg-card px-4 py-3.5 outline-none hover:border-input focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="line-clamp-2 text-[15px] leading-snug font-semibold">
                    {title}
                  </span>
                  {body && (
                    <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">
                      {body}
                    </span>
                  )}
                  <span className="mt-auto flex items-center gap-1.5 pt-1 font-mono text-[11px] text-muted-foreground">
                    {agent && <Familiar look={{ ...agent.spec.avatar, mark: "none" }} size={18} />}
                    {[agent?.name, timeAgo(run.endedAt ?? run.createdAt), took]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Working now ──────────────────────────────────────────────────────────────

function WorkingNow({
  runs,
  agents,
  moods,
}: {
  runs: readonly Run[];
  agents: Map<string, Agent>;
  moods: Map<string, { mood: FamiliarMood; run?: Run }>;
}) {
  return (
    <section aria-labelledby="working-now" className="flex flex-col gap-2.5">
      <SectionTitle id="working-now" count={runs.length || undefined}>
        Working now
      </SectionTitle>
      {runs.length === 0 ? (
        <p className="rounded-[18px] border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
          Nobody is working right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {runs.map((run) => {
            const agent = agents.get(run.agentId);
            return agent ? (
              <WorkingRow
                key={run.id}
                agent={agent}
                run={run}
                mood={moods.get(agent.id)?.mood ?? "working"}
              />
            ) : null;
          })}
        </ul>
      )}
    </section>
  );
}

function WorkingRow({ agent, run: listed, mood }: { agent: Agent; run: Run; mood: FamiliarMood }) {
  const { run: live, events } = useRun(listed.id);
  const run = live.data ?? listed;
  const now = useNow(true);
  const stop = useStopRun();
  const phase = runPhase(run.status, events.data ?? []);
  const calls = (events.data ?? []).filter((e) => e.type === "model.called").length;
  return (
    <li className="flex flex-col gap-3 rounded-[18px] border bg-card px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="relative size-11 shrink-0">
          <WorkingRing kind={phase.kind} />
          <Familiar
            look={agent.spec.avatar}
            mood={mood}
            size={34}
            animate
            ring="var(--card)"
            className="absolute top-1 left-[5px]"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{agent.name}</span>
          <span className="shimmer-text truncate text-[13px]" aria-live="polite">
            {phase.label}
            {phase.detail ? ` · ${phase.detail}` : ""}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {duration(now - Date.parse(run.startedAt ?? run.createdAt))} elapsed
            {calls ? ` · ${count(calls, "model call")}` : ""}
          </span>
        </div>
      </div>
      <div className="flex gap-2 pl-14">
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          search={run.threadId ? { thread: run.threadId } : {}}
          className={OUTLINE_SMALL}
        >
          Open chat
        </Link>
        <button
          type="button"
          onClick={() =>
            stop.mutate(run.id, {
              onSuccess: () => toast(`Stopping ${agent.name}`),
              onError: (e) => toast({ message: e.message, tone: "error" }),
            })
          }
          disabled={stop.isPending}
          className={OUTLINE_SMALL}
          aria-label={`Stop ${agent.name}`}
        >
          <Square className="size-3 fill-current" aria-hidden /> Stop
        </button>
      </div>
    </li>
  );
}

// ── Quota ────────────────────────────────────────────────────────────────────

/** Model requests today against the provider's daily free quota. */
function QuotaCard() {
  // The time of the last refresh (each minute) stands in for now.
  const { data: usage, dataUpdatedAt } = useUsageToday();
  if (!usage) return <div className="skeleton h-[132px] w-full rounded-[18px]" />;
  const limit = usage.dailyLimit;
  const share = limit ? Math.min(1, usage.requests / limit) : 0;
  const hours = (dataUpdatedAt - Date.parse(usage.since)) / 3_600_000;
  // Only project once there's enough of the day to go on.
  const projected = hours >= 2 ? Math.round((usage.requests / hours) * 24) : null;
  return (
    <section
      aria-labelledby="quota"
      className="flex flex-col gap-3 rounded-[18px] border bg-card px-4 py-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="quota" className="text-[15px] font-semibold">
          {limit ? "Free model quota today" : "Model requests today"}
        </h3>
        <span className="font-mono text-[11px] text-muted-foreground">
          resets {shortTime(usage.resetsAt)}
        </span>
      </div>
      <p className="font-display text-[28px] leading-none font-extrabold tracking-[-0.03em]">
        {usage.requests.toLocaleString()}
        {limit && (
          <span className="text-[15px] font-semibold tracking-normal text-muted-foreground">
            {" "}
            of {limit.toLocaleString()} requests
          </span>
        )}
      </p>
      {limit && (
        <div
          role="meter"
          aria-label="Share of today's quota used"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={usage.requests}
          className="h-2 overflow-hidden rounded-full bg-accent"
        >
          <div
            className={cn("h-full rounded-full", share > 0.85 ? "bg-warning" : "bg-primary")}
            style={{ width: `${Math.max(share * 100, usage.requests ? 2 : 0)}%` }}
          />
        </div>
      )}
      <p className="text-[12.5px] leading-snug text-muted-foreground">
        {projected !== null && limit
          ? `At today's pace you'll use about ${projected.toLocaleString()}. `
          : ""}
        {usage.perMinute
          ? `Agents slow down, not stop, near the ${usage.perMinute}-a-minute limit.`
          : "Counted from your agents' runs."}
      </p>
    </section>
  );
}
