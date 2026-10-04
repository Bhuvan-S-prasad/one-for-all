import type { Agent, FamiliarMood, Run, RunEvent } from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import { Square } from "lucide-react";
import { Familiar } from "@/components/familiar";
import { StepList } from "@/components/chat/reply";
import { countdown, duration } from "@/lib/format";
import { runPhase, runSteps } from "@/lib/run-steps";
import { cn } from "@/lib/utils";

// The run as it happens, at the bottom of the thread where the reply will
// appear (UX.07). The familiar is the loader: it moves with the phase, and the
// phase is said in words, with a timer, so the wait never looks stuck.

/** A ring that turns around a familiar while its agent works. */
export function WorkingRing({
  kind,
  className,
}: {
  kind: "queued" | "thinking" | "working" | "waiting";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 rounded-full border-2 border-transparent",
        kind === "waiting"
          ? "border-t-warning"
          : kind === "queued"
            ? "border-dashed border-muted-foreground/50"
            : kind === "thinking"
              ? "border-t-info border-r-info/30"
              : "border-t-primary border-r-primary/35",
        "animate-spin [animation-duration:1.4s]",
        className,
      )}
    />
  );
}

export function LiveRun({
  agent,
  run,
  events,
  mood,
  now,
  stopping,
  onStop,
}: {
  agent: Agent;
  run: Run;
  events: readonly RunEvent[];
  mood: FamiliarMood;
  now: number;
  stopping: boolean;
  onStop: () => void;
}) {
  const phase = runPhase(run.status, events);
  const steps = runSteps(events);
  const started = run.startedAt ?? run.createdAt;
  const elapsed = duration(now - Date.parse(started));

  return (
    <section
      aria-label={`${agent.name} is working`}
      className="grid grid-cols-[48px_minmax(0,1fr)] gap-3.5"
    >
      <div className="relative size-12">
        <WorkingRing kind={phase.kind} />
        <Familiar
          look={{ ...agent.spec.avatar, mark: "none" }}
          mood={mood}
          size={36}
          ring="var(--background)"
          animate
          className="absolute top-[5px] left-1.5"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-3 pt-1">
        {/* Announced once per phase, not per tick of the timer. */}
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1" aria-live="polite">
          <span
            className={cn(
              "text-[16px] font-semibold",
              phase.kind === "waiting" ? "text-warning" : "shimmer-text",
            )}
          >
            {phase.label}
            {phase.detail && <span className="font-normal"> {phase.detail}</span>}
          </span>
          <span className="font-mono text-xs text-muted-foreground" aria-hidden>
            {elapsed}
          </span>
        </div>

        {phase.kind === "waiting" && (
          <p className="rounded-[14px] border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-[13.5px]">
            The free models allow 20 requests a minute, so {agent.name} is waiting its turn.
            {phase.until && (
              <>
                {" "}
                Trying again in <span className="font-mono">{countdown(phase.until, now)}</span>.
              </>
            )}
          </p>
        )}

        {steps.length > 0 && (
          <div className="rounded-[18px] border bg-card px-4 py-3.5">
            <StepList steps={steps} limit={5} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="flex h-9 items-center gap-2 rounded-full border border-input px-3.5 text-[13px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <Square className="size-3 fill-current" aria-hidden />
            {stopping ? "Stopping…" : "Stop"}
            <kbd className="rounded-[5px] border px-1 font-mono text-[10.5px] font-normal text-muted-foreground">
              Esc
            </kbd>
          </button>
          <span className="text-[12.5px] text-muted-foreground">
            You can leave this page; {agent.name} keeps working.{" "}
            <Link
              to="/activity"
              search={{ run: run.id }}
              className="underline-offset-2 hover:underline"
            >
              Details
            </Link>
          </span>
        </div>
      </div>
    </section>
  );
}
