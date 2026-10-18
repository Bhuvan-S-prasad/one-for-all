import { useAgents, useRun, useRunArtifacts, useRunHandoffs } from "@ofa/client";
import type { Agent, Message, Run, RunEvent } from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Copy,
  Download,
  Lightbulb,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { FileCard } from "@/components/chat/file-card";
import { Handoffs } from "@/components/chat/handoffs";
import { Familiar } from "@/components/familiar";
import { headingId, Markdown } from "@/components/markdown";
import { duration, shortTime } from "@/lib/format";
import { inlineText, isDocument, outline, parseMarkdown, type Block } from "@/lib/markdown";
import {
  runSources,
  runSteps,
  runSummary,
  summaryLine,
  type RunSource,
  type RunStep,
} from "@/lib/run-steps";
import { useSeen } from "@/lib/use-now";
import { cn } from "@/lib/utils";

// One agent reply (UX.05, UX.08, UX.09): a line saying what the run did, the
// answer as Markdown (a bubble, or a document when it is long), the pages it
// read, and Copy / Try again.

export function StepIcon({ state }: { state: RunStep["state"] }) {
  const base = "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full";
  if (state === "done")
    return (
      <span className={cn(base, "bg-primary text-primary-foreground")}>
        <Check className="size-3" strokeWidth={3} aria-label="Done" />
      </span>
    );
  if (state === "failed")
    return (
      <span className={cn(base, "bg-destructive-surface text-destructive")}>
        <X className="size-3" strokeWidth={3} aria-label="Failed" />
      </span>
    );
  if (state === "blocked")
    return (
      <span className={cn(base, "bg-warning/15 text-warning")}>
        <CircleSlash className="size-3" strokeWidth={3} aria-label="Not allowed" />
      </span>
    );
  return (
    <span className={cn(base, "border-2 border-primary")} aria-label="In progress">
      <span className="size-2 animate-pulse rounded-full bg-primary" />
    </span>
  );
}

export function StepList({ steps, limit }: { steps: readonly RunStep[]; limit?: number }) {
  const hidden = limit ? Math.max(0, steps.length - limit) : 0;
  return (
    <ol className="flex flex-col gap-2.5 text-sm">
      {hidden > 0 && (
        <li className="pl-[30px] text-xs text-muted-foreground">
          {hidden} earlier step{hidden === 1 ? "" : "s"}
        </li>
      )}
      {steps.slice(hidden).map((step) => (
        <li key={step.id} className="flex items-start gap-2.5">
          <StepIcon state={step.state} />
          <span className={cn("min-w-0 flex-1", step.state === "active" && "font-semibold")}>
            {step.label}
            {step.detail && (
              <span className="block truncate font-mono text-xs font-normal text-muted-foreground">
                {step.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "Worked 2 min 14 s · 1 search · read 6 pages", opening into the steps. */
function WorkedLine({ run, events }: { run: Run; events: readonly RunEvent[] }) {
  const [open, setOpen] = useState(false);
  const steps = runSteps(events);
  const took =
    run.startedAt && run.endedAt
      ? duration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
      : null;
  const used = summaryLine(runSummary(events));
  const text = [took ? `Worked ${took}` : "Done", used].filter(Boolean).join(" · ");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={steps.length === 0}
        className="flex h-7 max-w-full items-center gap-1.5 self-start rounded-full border bg-card px-2.5 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:hover:text-muted-foreground"
      >
        <Check className="size-3 shrink-0 text-success" strokeWidth={3} aria-hidden />
        <span className="truncate">{text}</span>
        {steps.length > 0 &&
          (open ? (
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" aria-hidden />
          ))}
      </button>
      {open && (
        <div className="flex flex-col gap-3 rounded-[16px] border bg-card px-4 py-3.5">
          <StepList steps={steps} />
          <Link
            to="/activity"
            search={{ run: run.id }}
            className="self-start text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Everything this run did →
          </Link>
        </div>
      )}
    </div>
  );
}

export function SourceList({ sources }: { sources: readonly RunSource[] }) {
  const read = sources.filter((s) => s.state === "read");
  const failed = sources.filter((s) => s.state === "failed");
  if (read.length === 0 && failed.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <span className="eyebrow text-[11px] text-muted-foreground">Sources · {read.length}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          Only pages the agent opened are numbered
        </span>
      </div>
      <ul className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:grid sm:grid-cols-2 sm:gap-x-3 sm:gap-y-0.5 sm:overflow-visible sm:pb-0">
        {read.map((s) => (
          <li key={s.url} className="w-[78%] shrink-0 snap-start sm:w-auto">
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer noopener"
              className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-[12px] border px-2.5 py-2.5 text-[13.5px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:border-0 sm:px-2 sm:py-2"
            >
              <span className="font-mono text-[11.5px] text-muted-foreground">{s.n}</span>
              <span className="truncate">
                {s.title ?? s.host}
                {s.title && <span className="text-muted-foreground"> · {s.host}</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <p className="px-2 text-xs text-muted-foreground">
          Couldn't load: {failed.map((s) => s.host).join(", ")}
        </p>
      )}
    </div>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function fileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "reply"}.md`;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2_000);
        })
      }
      className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
    </button>
  );
}

/** A long answer: title, outline, collapsed tail, and its sources. */
function DocumentCard({
  text,
  blocks,
  sources,
}: {
  text: string;
  blocks: readonly Block[];
  sources: readonly RunSource[];
}) {
  const [expanded, setExpanded] = useState(false);
  const first = blocks[0];
  const titled = first?.type === "heading" && first.level <= 2;
  const title = titled ? inlineText(first.children) : null;
  const body = titled ? blocks.slice(1) : blocks;
  const sections = outline(body);
  const words = text.split(/\s+/).filter(Boolean).length;
  const read = sources.filter((s) => s.state === "read").length;
  const long = text.length > 2_400;

  return (
    <div className="overflow-hidden rounded-[22px] border bg-card">
      <div className="flex items-start justify-between gap-4 border-b px-5 pt-4 pb-3.5 sm:px-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          {title && (
            <h2 className="text-[24px] leading-tight font-extrabold tracking-[-0.025em] sm:text-[28px]">
              {title}
            </h2>
          )}
          <span className="font-mono text-xs text-muted-foreground">
            about {words.toLocaleString()} words
            {read ? ` · ${read} source${read === 1 ? "" : "s"}` : ""} ·{" "}
            {Math.max(1, Math.round(words / 220))} min read
          </span>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <CopyButton text={text} label="Copy the answer" />
          <button
            type="button"
            aria-label="Save as a file"
            title="Save as a file"
            onClick={() => download(fileName(title ?? "reply"), text)}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className={cn("grid", sections.length >= 3 && "lg:grid-cols-[170px_minmax(0,1fr)]")}>
        {sections.length >= 3 && (
          <nav
            aria-label="Sections"
            className="hidden flex-col gap-2 border-r py-5 pr-3 pl-6 text-[13px] lg:flex"
          >
            <span className="eyebrow text-[10px] text-muted-foreground">In this answer</span>
            {sections.map((s) => (
              <a
                key={s.index}
                href={`#${headingId(s.text, s.index)}`}
                onClick={() => setExpanded(true)}
                className={cn(
                  "text-muted-foreground hover:text-foreground",
                  s.level === 3 && "pl-3 text-[12.5px]",
                )}
              >
                {s.text}
              </a>
            ))}
          </nav>
        )}
        <div className="relative min-w-0 px-5 py-5 sm:px-7">
          <div className={cn(long && !expanded && "max-h-[560px] overflow-hidden")}>
            <Markdown blocks={body} sources={sources} className="text-[15.5px] leading-[1.7]" />
          </div>
          {long && !expanded && (
            <div className="absolute inset-x-0 bottom-0 flex h-36 items-end justify-start bg-gradient-to-t from-card via-card/90 to-transparent px-5 pb-5 sm:px-7">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="flex h-9 items-center gap-2 rounded-full border bg-popover px-4 text-[13.5px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                Show the rest <ChevronDown className="size-4" aria-hidden />
              </button>
            </div>
          )}
        </div>
      </div>

      {sources.length > 0 && (
        <div className="border-t px-4 pt-3.5 pb-4 sm:px-5">
          <SourceList sources={sources} />
        </div>
      )}
    </div>
  );
}

const BUDGET_WORDS: Record<string, string> = {
  step_budget: "step limit",
  token_budget: "token budget",
  cost_budget: "cost budget",
};

/**
 * Quiet lines under a reply (UX.14, UX.15): what the run learned, and a run
 * that stopped at its budget, with Continue.
 */
function ReplyNotes({
  agent,
  events,
  onContinue,
}: {
  agent: Agent;
  events: readonly RunEvent[];
  onContinue?: () => void;
}) {
  const learned = events.flatMap((e) => (e.type === "memory.written" ? [e.payload] : []));
  const unconfirmed = learned.filter((m) => !m.verified).length;
  const ended = events.find((e) => e.type === "run.ended");
  const budget =
    ended?.type === "run.ended" ? BUDGET_WORDS[ended.payload.stopReason ?? ""] : undefined;
  if (learned.length === 0 && !budget) return null;
  return (
    <div className="flex flex-col gap-2">
      {budget && ended?.type === "run.ended" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border px-3.5 py-2.5 text-[13px] text-muted-foreground">
          <span className="min-w-0 flex-1">
            Stopped at its {budget} after {ended.payload.usage.modelCalls} model calls. The answer
            so far is above.
          </span>
          {onContinue && (
            <button
              type="button"
              onClick={onContinue}
              className="flex h-8 items-center gap-1.5 rounded-full border border-input px-3 text-[13px] font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Play className="size-3.5" aria-hidden /> Continue
            </button>
          )}
        </div>
      )}
      {learned.length > 0 && (
        <Link
          to="/agents/$agentId/memory"
          params={{ agentId: agent.id }}
          className="flex items-center gap-2 self-start rounded-full px-1 text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Lightbulb className="size-3.5" aria-hidden />
          Learned {learned.length} thing{learned.length === 1 ? "" : "s"}
          {unconfirmed > 0 && (
            <span className="font-semibold text-foreground">
              · confirm {unconfirmed === learned.length ? "before" : `${unconfirmed} before`}{" "}
              {agent.name} uses {unconfirmed === 1 ? "it" : "them"}
            </span>
          )}
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      )}
    </div>
  );
}

export function Reply({
  message,
  agent,
  onRetry,
  onContinue,
}: {
  message: Message;
  agent: Agent;
  /** Ask again with the message this reply answered; absent when there is none. */
  onRetry?: () => void;
  /** Continue a run that stopped at its budget (the latest reply only). */
  onContinue?: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // Only replies on (or near) the screen load their run's steps and sources.
  const seen = useSeen(ref);
  const { run, events } = useRun(seen && message.runId ? message.runId : undefined);
  const blocks = useMemo(() => parseMarkdown(message.content), [message.content]);
  const sources = useMemo(() => runSources(events.data ?? []), [events.data]);
  const doc = isDocument(message.content, blocks);
  // Files the agent wrote or sent in this run (M3.06), fetched only when there are some.
  const wroteFiles = (events.data ?? []).some(
    (e) =>
      e.type === "tool.completed" &&
      (e.payload.tool === "files.write" || e.payload.tool === "files.send") &&
      e.payload.artifactId,
  );
  const { data: artifacts } = useRunArtifacts(message.runId ?? undefined, { enabled: wroteFiles });
  // Work it handed to other agents (TC.10), and the files they made: a file a
  // teammate wrote reaches the person here, under this reply.
  const handedOn = (events.data ?? []).some((e) => e.type === "delegation.started");
  const { data: handoffs } = useRunHandoffs(message.runId ?? undefined, { enabled: handedOn });
  const { data: agents } = useAgents();
  const files = [
    ...(artifacts ?? []).filter((a) => a.kind === "file"),
    ...(handoffs ?? []).flatMap((h) => h.files),
  ];

  return (
    <article
      ref={ref}
      aria-label={`${agent.name}'s reply`}
      className="group/reply flex flex-col gap-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2">
          <Familiar
            look={{ ...agent.spec.avatar, mark: "none" }}
            size={30}
            ring="var(--background)"
          />
          <span className="text-[14px] font-semibold">{agent.name}</span>
        </span>
        {run.data && events.data && run.data.endedAt && (
          <WorkedLine run={run.data} events={events.data} />
        )}
      </div>

      {doc ? (
        <DocumentCard text={message.content} blocks={blocks} sources={sources} />
      ) : (
        <div className="flex flex-col gap-3 self-start rounded-[6px_22px_22px_22px] bg-card px-4 py-3 sm:max-w-[88%]">
          <Markdown blocks={blocks} sources={sources} className="text-[15px] leading-relaxed" />
          {sources.some((s) => s.state === "read") && (
            <div className="-mx-1 flex snap-x gap-1.5 overflow-x-auto border-t px-1 pt-2.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
              {sources
                .filter((s) => s.state === "read")
                .map((s) => (
                  <a
                    key={s.url}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex h-8 shrink-0 snap-start items-center gap-1.5 rounded-full border px-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:px-2.5"
                  >
                    <span className="font-mono">{s.n}</span>
                    {s.host}
                  </a>
                ))}
            </div>
          )}
        </div>
      )}

      {handoffs && handoffs.length > 0 && <Handoffs handoffs={handoffs} agents={agents ?? []} />}

      {files.length > 0 && (
        <div className="flex flex-col gap-2 sm:max-w-[88%]">
          {files.map((file) => (
            <FileCard key={file.id} file={file} agentName={agent.name} />
          ))}
        </div>
      )}

      {events.data && <ReplyNotes agent={agent} events={events.data} onContinue={onContinue} />}

      <div className="flex items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-focus-within/reply:opacity-100 md:group-hover/reply:opacity-100">
        {!doc && <CopyButton text={message.content} label="Copy the reply" />}
        {onRetry && (
          <button
            type="button"
            aria-label="Ask again"
            title="Ask again"
            onClick={onRetry}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCcw className="size-4" aria-hidden />
          </button>
        )}
        <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
          {shortTime(message.createdAt)}
        </span>
      </div>
    </article>
  );
}
