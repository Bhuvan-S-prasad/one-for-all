import type { Agent, Run, RunEvent } from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import { Check, ShieldAlert, X } from "lucide-react";
import { count, duration } from "@/lib/format";
import { runPlan, runSources } from "@/lib/run-steps";
import { cn } from "@/lib/utils";

// Beside the chat on wide screens (UX.07): the agent's plan, the pages it has
// read so far, how much of its budget it has used, and the outside-content
// notice. Everything comes from the run and its log.

function Meter({
  label,
  used,
  of,
  note,
}: {
  label: string;
  used: number;
  of: number;
  note?: string;
}) {
  const share = of > 0 ? Math.min(1, used / of) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-xs">
          {used.toLocaleString()} / {of.toLocaleString()}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={of}
        aria-valuenow={used}
        className="h-1 overflow-hidden rounded-full bg-accent"
      >
        <div
          className={cn("h-full rounded-full", share > 0.85 ? "bg-warning" : "bg-foreground")}
          style={{ width: `${share * 100}%` }}
        />
      </div>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="eyebrow font-sans text-[10.5px] tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function RunPanel({
  agent,
  run,
  events,
  active,
  now,
}: {
  agent: Agent;
  run: Run;
  events: readonly RunEvent[];
  active: boolean;
  now: number;
}) {
  const plan = runPlan(events);
  const sources = runSources(events);
  const started = run.startedAt ? Date.parse(run.startedAt) : null;
  const ended = run.endedAt ? Date.parse(run.endedAt) : now;
  // The run's totals are written when it ends; while it works, count from its log.
  const calls = events.filter((e) => e.type === "model.called");
  const modelCalls = active ? calls.length : run.usage.modelCalls;
  const tokens = active
    ? calls.reduce(
        (sum, e) =>
          sum + (e.type === "model.called" ? e.payload.inputTokens + e.payload.outputTokens : 0),
        0,
      )
    : run.usage.inputTokens + run.usage.outputTokens;

  return (
    <aside
      aria-label={active ? "This run" : "Last run"}
      className="hidden w-[320px] shrink-0 flex-col gap-6 overflow-y-auto border-l bg-background px-5 py-5 lg:flex"
    >
      <div className="flex items-center justify-between">
        <span className="font-display text-[17px] font-bold">
          {active ? "This run" : "Last run"}
        </span>
        <Link
          to="/activity"
          search={{ run: run.id }}
          className="text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Full log →
        </Link>
      </div>

      {plan && plan.length > 0 && (
        <Section title={`Plan · ${plan.filter((p) => p.done).length} of ${plan.length} done`}>
          <ul className="flex flex-col gap-2 text-[13.5px]">
            {plan.map((item, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    item.done && "border-primary bg-primary text-primary-foreground",
                  )}
                  role="img"
                  aria-label={item.done ? "Done" : "Not done yet"}
                >
                  {item.done && <Check className="size-2.5" strokeWidth={3.5} aria-hidden />}
                </span>
                <span
                  className={cn(
                    item.done &&
                      "text-muted-foreground line-through decoration-muted-foreground/50",
                  )}
                >
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={active ? "Pages so far" : "Pages"}>
        {sources.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {active ? "None yet." : "It answered without reading any pages."}
          </p>
        ) : (
          <ul className="flex flex-col text-[13px]">
            {sources.map((s, i) => (
              <li
                key={`${s.url}-${i}`}
                className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 py-1.5"
              >
                <span className="font-mono text-[11px] text-muted-foreground">{s.n ?? ""}</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={s.title ?? s.url}
                  className="truncate hover:underline"
                >
                  {s.host}
                </a>
                {s.state === "read" ? (
                  <span className="eyebrow text-[9.5px] text-success">Read</span>
                ) : s.state === "failed" ? (
                  <span className="eyebrow flex items-center gap-1 text-[9.5px] text-destructive">
                    <X className="size-3" aria-hidden /> Failed
                  </span>
                ) : (
                  <span className="eyebrow animate-pulse text-[9.5px] text-primary">Reading</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Budget">
        <Meter label="Model calls" used={modelCalls} of={agent.spec.budgets.steps} />
        <Meter label="Tokens" used={tokens} of={agent.spec.budgets.tokens} />
        {started !== null && (
          <div className="flex justify-between text-[13px]">
            <span className="text-muted-foreground">Time</span>
            <span className="font-mono text-xs">{duration(ended - started)}</span>
          </div>
        )}
        {!active && (
          <p className="text-xs text-muted-foreground">
            {count(run.usage.toolCalls, "tool call")} ·{" "}
            {run.usage.costUsd > 0 ? `$${run.usage.costUsd.toFixed(4)}` : "free"}
          </p>
        )}
      </Section>

      {run.tainted && (
        <div className="flex gap-3 rounded-[16px] border border-warning/30 bg-warning/10 p-3.5">
          <ShieldAlert className="mt-0.5 size-[18px] shrink-0 text-warning" aria-hidden />
          <div className="flex flex-col gap-1">
            <span className="text-[13.5px] font-semibold">Read outside content</span>
            <span className="text-[12.5px] leading-snug text-muted-foreground">
              For the rest of this run, anything that sends data out needs your approval.
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}
