import { moodFor, useAgents, useRun, useRuns, useStopRun } from "@ofa/client";
import type { Agent, Run, RunEvent } from "@ofa/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Square } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";
import { Familiar } from "@/components/familiar";
import { MoodPill } from "@/components/mood-pill";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { HOUSEHOLD } from "@/lib/familiars";
import { clockTime, count, duration, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/activity")({
  staticData: { title: "Activity" },
  validateSearch: (search: Record<string, unknown>): { run?: string } =>
    typeof search.run === "string" ? { run: search.run } : {},
  component: ActivityPage,
});

const ACTIVE = new Set(["queued", "running", "waiting"]);

const STATUS_WORDS: Record<Run["status"], string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

/** Every run, newest first, and the full log of the one you pick (ADR-0014). */
function ActivityPage() {
  const { run: selected } = Route.useSearch();
  const { data: runs, isPending, error } = useRuns();
  const { data: agents } = useAgents();
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));

  if (error) return <ErrorAlert>Couldn't load activity: {error.message}</ErrorAlert>;
  if (isPending) return <p className="text-muted-foreground">Loading…</p>;
  if (runs.length === 0) {
    return (
      <ComingSoon
        familiar={HOUSEHOLD.ledger}
        mood="asleep"
        heading="Nothing has run yet"
        badge="Activity"
      >
        Every run an agent makes shows up here, step by step: what it searched, what it read and
        what it decided.
      </ComingSoon>
    );
  }
  const current = runs.find((r) => r.id === selected) ?? runs[0];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <ul aria-label="Runs" className="flex flex-col gap-2">
        {runs.map((run) => {
          const agent = byId.get(run.agentId);
          return (
            <li key={run.id}>
              <Link
                to="/activity"
                search={{ run: run.id }}
                aria-current={run.id === current?.id ? "true" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 outline-none hover:border-input focus-visible:ring-2 focus-visible:ring-ring",
                  run.id === current?.id && "border-primary",
                )}
              >
                {agent && (
                  <Familiar
                    look={agent.spec.avatar}
                    size={40}
                    ring="var(--card)"
                    mood={moodFor({ agentStatus: "active", run })}
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">{agent?.name ?? "Agent"}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {STATUS_WORDS[run.status]} · {timeAgo(run.createdAt)}
                  </span>
                </div>
                {run.tainted && (
                  <span className="eyebrow text-[10px] text-warning" title="Read outside content">
                    Outside content
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {current && <RunDetail runId={current.id} agent={byId.get(current.agentId)} />}
    </div>
  );
}

function RunDetail({ runId, agent }: { runId: string; agent?: Agent }) {
  const { run, events } = useRun(runId);
  const stop = useStopRun();
  if (!run.data) return null;
  const r = run.data;
  const active = ACTIVE.has(r.status);
  const took =
    r.startedAt && r.endedAt ? duration(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : null;

  return (
    <section aria-label="Run" className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[26px] leading-tight font-bold tracking-[-0.02em]">
            {agent ? (
              <Link
                to="/agents/$agentId"
                params={{ agentId: agent.id }}
                className="hover:underline"
              >
                {agent.name}
              </Link>
            ) : (
              "Run"
            )}
          </h2>
          <span className="font-mono text-xs text-muted-foreground">
            {STATUS_WORDS[r.status]}
            {took ? ` in ${took}` : ""} · {count(r.usage.modelCalls, "model call")} ·{" "}
            {count(r.usage.toolCalls, "tool call")} ·{" "}
            {count(r.usage.inputTokens + r.usage.outputTokens, "token")}
            {r.usage.costUsd > 0 ? ` · $${r.usage.costUsd.toFixed(4)}` : " · free"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <MoodPill
            mood={moodFor({ agentStatus: "active", run: r, lastEvent: events.data?.at(-1) })}
          />
          {active && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => stop.mutate(r.id)}
              disabled={stop.isPending}
            >
              <Square aria-hidden /> Stop
            </Button>
          )}
        </div>
      </header>
      {r.error && <ErrorAlert>{r.error.message}</ErrorAlert>}
      <ol className="flex flex-col">
        {(events.data ?? []).map((event) => (
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
    </section>
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
            // The learning pass, logged after the run finished.
            event.payload.promptVersion?.startsWith("memory.extract")
              ? "Looked back for things to remember"
              : "Model answered",
          )}
          {note(
            `${event.payload.model} · ${event.payload.inputTokens}→${event.payload.outputTokens} tokens · ${duration(event.payload.durationMs)}` +
              (event.payload.toolCalls
                ? ` · ${event.payload.toolCalls} tool call${event.payload.toolCalls > 1 ? "s" : ""}`
                : "") +
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
