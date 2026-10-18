import { useRun } from "@ofa/client";
import type { Agent, Handoff } from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { StepList } from "@/components/chat/reply";
import { Familiar } from "@/components/familiar";
import { Markdown } from "@/components/markdown";
import { parseMarkdown } from "@/lib/markdown";
import { runSources, runSteps } from "@/lib/run-steps";
import { cn } from "@/lib/utils";

// The work a reply handed to other agents (ADR-0032, TC.10): each handoff
// runs in a thread of its own, kept out of the person's chat list, so the
// person sees it here instead: who was asked what, how it went, what came
// back. Steps load only when a card is opened.

const STATUS: Record<Handoff["status"], { label: string; tone: string }> = {
  working: { label: "Working…", tone: "text-primary" },
  done: { label: "Done", tone: "text-success" },
  stopped: { label: "Stopped early", tone: "text-warning" },
  failed: { label: "Failed", tone: "text-destructive" },
  cancelled: { label: "Stopped", tone: "text-muted-foreground" },
};

function firstLine(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function HandoffCard({ handoff, agent }: { handoff: Handoff; agent: Agent | undefined }) {
  const [open, setOpen] = useState(false);
  const { events } = useRun(open ? handoff.childRunId : undefined);
  const steps = runSteps(events.data ?? []);
  const sources = useMemo(() => runSources(events.data ?? []), [events.data]);
  const answer = useMemo(() => parseMarkdown(handoff.reply ?? ""), [handoff.reply]);
  const status = STATUS[handoff.status];

  return (
    <li className="overflow-hidden rounded-[16px] border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {agent ? (
          <Familiar look={{ ...agent.spec.avatar, mark: "none" }} size={26} ring="var(--card)" />
        ) : (
          <span aria-hidden className="size-[26px] shrink-0 rounded-full bg-muted" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2 text-[13.5px]">
            <span className="font-semibold">{handoff.agentName}</span>
            <span className={cn("text-[12px] font-medium", status.tone)}>{status.label}</span>
          </span>
          <span className="truncate text-[12.5px] text-muted-foreground">
            {firstLine(handoff.brief) || "No brief"}
          </span>
        </span>
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-4 border-t px-4 py-3.5">
          <section className="flex flex-col gap-1.5">
            <h4 className="eyebrow text-[11px] text-muted-foreground">What it was asked</h4>
            <p className="max-h-56 overflow-y-auto text-[13.5px] leading-relaxed whitespace-pre-wrap">
              {handoff.brief ?? "No brief"}
            </p>
          </section>
          <section className="flex flex-col gap-1.5">
            <h4 className="eyebrow text-[11px] text-muted-foreground">How it went</h4>
            {events.isPending ? (
              <p className="text-sm text-muted-foreground">Loading its steps…</p>
            ) : steps.length ? (
              <StepList steps={steps} limit={12} />
            ) : (
              <p className="text-sm text-muted-foreground">No steps yet.</p>
            )}
          </section>
          <section className="flex flex-col gap-1.5">
            <h4 className="eyebrow text-[11px] text-muted-foreground">What it sent back</h4>
            {handoff.reply ? (
              <div className="max-h-96 overflow-y-auto rounded-[12px] bg-background px-3.5 py-3">
                <Markdown
                  blocks={answer}
                  sources={sources}
                  className="text-[14px] leading-relaxed"
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing yet.</p>
            )}
          </section>
          <Link
            to="/activity"
            search={{ run: handoff.childRunId }}
            className="self-start text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Everything {handoff.agentName} did →
          </Link>
        </div>
      )}
    </li>
  );
}

export function Handoffs({
  handoffs,
  agents,
}: {
  handoffs: readonly Handoff[];
  agents: readonly Agent[];
}) {
  if (handoffs.length === 0) return null;
  const byId = new Map(agents.map((a) => [a.id, a]));
  return (
    <section aria-label="Work handed to the team" className="flex flex-col gap-2 sm:max-w-[88%]">
      <span className="eyebrow px-1 text-[11px] text-muted-foreground">
        Handed to the team · {handoffs.length}
      </span>
      <ul className="flex flex-col gap-2">
        {handoffs.map((h) => (
          <HandoffCard key={h.childRunId} handoff={h} agent={byId.get(h.agentId)} />
        ))}
      </ul>
    </section>
  );
}
