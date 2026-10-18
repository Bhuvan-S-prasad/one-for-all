import {
  AppWindow,
  Brain,
  CircleSlash,
  Clock,
  FileText,
  FolderOpen,
  Globe,
  Hand,
  KeyRound,
  ListChecks,
  Mail,
  MessageSquare,
  Monitor,
  Search,
  Send,
  Sparkles,
  SquareTerminal,
  UserRound,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { createElement, useState } from "react";
import { duration } from "@/lib/format";
import { groupSteps, type RunStep, type StepGroup } from "@/lib/run-steps";
import { cn } from "@/lib/utils";

// The trail of a run (UX.07, UX.09): one quiet line per step, each with the
// icon of what it used, joined by a thin line. Work that went fine stays in
// the background; the step under way shimmers, a failure says what went wrong
// in plain words, and lookups in a row fold into one line with their targets
// as chips (Perplexity's steps, Claude's tool calls). State is shown by the
// icon's shape as well as its colour.

const ICONS: [prefix: string, icon: LucideIcon][] = [
  ["web.search", Search],
  ["web.read_url", Globe],
  ["browser.", AppWindow],
  ["desktop.", Monitor],
  ["shell.", SquareTerminal],
  ["files.send", Send],
  ["files.list", FolderOpen],
  ["files.", FileText],
  ["artifacts.", FileText],
  ["remember", Brain],
  ["recall", Brain],
  ["todo.write", ListChecks],
  ["delegate_task", UserRound],
  ["message_agent", MessageSquare],
  ["schedule_task", Clock],
  ["remind_me", Clock],
  ["run_skill", Sparkles],
  ["save_skill", Sparkles],
  ["use_saved_login", KeyRound],
  ["gmail.", Mail],
];

function iconFor(tool: string | null): LucideIcon {
  if (tool === null) return Hand;
  return ICONS.find(([prefix]) => tool.startsWith(prefix))?.[1] ?? Wrench;
}

const STATE_WORDS: Record<RunStep["state"], string> = {
  done: "Done",
  active: "In progress",
  failed: "Didn't work",
  blocked: "Not allowed",
};

function StepMark({ row }: { row: StepGroup }) {
  const icon = createElement(
    row.state === "failed" ? X : row.state === "blocked" ? CircleSlash : iconFor(row.tool),
    { className: "size-3", strokeWidth: 2.25, "aria-hidden": true },
  );
  return (
    <span
      role="img"
      aria-label={STATE_WORDS[row.state]}
      className={cn(
        "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background",
        row.state === "done" && "text-muted-foreground",
        row.state === "active" && "border-primary/60 text-primary",
        row.state === "failed" && "border-destructive/40 bg-destructive-surface text-destructive",
        row.state === "blocked" && "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      {row.state === "active" && (
        <span
          aria-hidden
          className="absolute -inset-px animate-spin rounded-full border-2 border-transparent border-t-primary [animation-duration:1.2s]"
        />
      )}
      {icon}
    </span>
  );
}

/** Targets that read better as plain text than as code. */
const PROSE = new Set(["delegate_task", "message_agent", "todo.write", "remember"]);

function StepRow({ row, last }: { row: StepGroup; last: boolean }) {
  const [all, setAll] = useState(false);
  const took = row.durationMs !== null && row.durationMs >= 1_000 ? duration(row.durationMs) : null;
  const chips = row.count > 1 && row.details.length > 0;
  const shown = all ? row.details : row.details.slice(0, 6);
  const detail = !chips ? row.details[0] : undefined;
  const failed = row.state === "failed" || row.state === "blocked";

  return (
    <li className={cn("relative flex gap-3", !last && "pb-3")}>
      {!last && (
        <span aria-hidden className="absolute top-6 bottom-0 left-[11.5px] w-px bg-border" />
      )}
      <StepMark row={row} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-[3px]">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 text-[13.5px] leading-snug",
              row.state === "active" ? "shimmer-text font-medium" : "text-foreground/85",
              failed && "text-foreground/70",
            )}
          >
            {row.label}
            {row.count > 1 && <span className="text-muted-foreground"> · {row.count}</span>}
          </span>
          {took && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{took}</span>
          )}
        </div>
        {detail && (
          <span
            title={detail}
            className={cn(
              "text-[12.5px] leading-snug",
              failed
                ? "text-destructive/90"
                : row.tool && !PROSE.has(row.tool)
                  ? "truncate font-mono text-[12px] text-muted-foreground"
                  : "line-clamp-2 text-muted-foreground",
              row.state === "blocked" && "text-warning",
            )}
          >
            {detail}
          </span>
        )}
        {chips && (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {shown.map((d, i) => (
              <li
                key={`${d}-${i}`}
                title={d}
                className="max-w-full truncate rounded-full bg-muted px-2.5 py-0.5 text-[12px] text-muted-foreground"
              >
                {d}
              </li>
            ))}
            {row.details.length > shown.length && (
              <li>
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className="rounded-full px-2 py-0.5 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  +{row.details.length - shown.length} more
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </li>
  );
}

/** The steps of a run as a trail; `limit` keeps the newest, with the rest a click away. */
export function StepList({ steps, limit }: { steps: readonly RunStep[]; limit?: number }) {
  const [everything, setEverything] = useState(false);
  const rows = groupSteps(steps);
  const hidden = limit && !everything ? Math.max(0, rows.length - limit) : 0;
  const visible = rows.slice(hidden);
  return (
    <div className="flex flex-col gap-2">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setEverything(true)}
          className="self-start pl-9 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Show {hidden} earlier step{hidden === 1 ? "" : "s"}
        </button>
      )}
      <ol className="flex flex-col">
        {visible.map((row, i) => (
          <StepRow key={row.id} row={row} last={i === visible.length - 1} />
        ))}
      </ol>
    </div>
  );
}
