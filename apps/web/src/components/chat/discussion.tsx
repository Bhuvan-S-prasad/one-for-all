import type { Agent, Discussion, Message } from "@ofa/contracts";
import { Check, ChevronDown, ChevronRight, MessagesSquare, Pin, Square } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Familiar } from "@/components/familiar";
import { foldLabel, progressOf, type TurnState } from "@/lib/discussions";
import { cn } from "@/lib/utils";

// A group discussion in the chat (ADR-0050): whose turn it is while it runs,
// its turns folded once it closed, and the agreed answer pinned. States are
// written out as well as styled: never colour alone.

const STATE_LABEL: Record<TurnState, string> = {
  answered: "answered",
  passed: "passed",
  speaking: "answering…",
  skipped: "couldn't answer",
  waiting: "waiting",
};

function Chip(props: {
  agent: Agent | undefined;
  label: string;
  state: TurnState | "closes" | "closing";
}) {
  const live = props.state === "speaking" || props.state === "closing";
  const done = props.state === "answered" || props.state === "passed";
  return (
    <li
      className={cn(
        "flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-[12.5px]",
        live ? "border-foreground font-semibold" : "border-border",
        (props.state === "waiting" || props.state === "closes") && "text-muted-foreground",
      )}
    >
      {props.agent ? (
        <Familiar
          look={{ ...props.agent.spec.avatar, mark: "none" }}
          size={20}
          ring="var(--card)"
        />
      ) : (
        <span aria-hidden className="size-5 rounded-full bg-muted" />
      )}
      <span>{props.agent?.name ?? "An agent"}</span>
      <span className={cn("flex items-center gap-1", !live && "text-muted-foreground")}>
        {done && <Check className="size-3" aria-hidden />}
        {props.label}
      </span>
    </li>
  );
}

/** Whose turn it is: the round, each member in order, then the coordinator's close. */
export function DiscussionBar(props: {
  discussion: Discussion;
  byId: ReadonlyMap<string, Agent>;
  stopping: boolean;
  onStop: () => void;
}) {
  const { discussion, byId } = props;
  const progress = progressOf(discussion);
  const coordinator = byId.get(discussion.coordinatorAgentId);
  const now = progress.current ? byId.get(progress.current)?.name : null;
  const said =
    progress.closing === "writing"
      ? `${coordinator?.name ?? "The coordinator"} is writing the agreed answer`
      : now
        ? `${now}'s turn`
        : "Starting the next turn";

  return (
    <section
      aria-label="Discussion"
      className="flex flex-col gap-2 rounded-[18px] border bg-card px-3.5 py-2.5"
    >
      <div className="flex items-center gap-2 text-[13px]">
        <MessagesSquare className="size-4 shrink-0" aria-hidden />
        <span className="font-semibold">Discussion</span>
        <span className="text-muted-foreground">
          Round {progress.round} of {discussion.rounds}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" aria-live="polite">
          · {said}
        </span>
        <button
          type="button"
          onClick={props.onStop}
          disabled={props.stopping}
          className="flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Square className="size-3 fill-current" aria-hidden />
          Stop
        </button>
      </div>
      <ol aria-label="Order" className="flex flex-wrap items-center gap-1.5">
        {progress.members.map((m) => (
          <Chip
            key={m.agentId}
            agent={byId.get(m.agentId)}
            state={m.state}
            label={STATE_LABEL[m.state]}
          />
        ))}
        <Chip
          agent={coordinator}
          state={progress.closing === "writing" ? "closing" : "closes"}
          label={progress.closing === "writing" ? "writing the answer…" : "closes"}
        />
      </ol>
    </section>
  );
}

/** An ended discussion's turns, folded: "4 messages with 2 agents". */
export function FoldedTurns(props: {
  messages: readonly Message[];
  byId: ReadonlyMap<string, Agent>;
  render: (message: Message) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const agents = [
    ...new Set(
      props.messages.flatMap((m) => (m.author.type === "agent" ? [m.author.agentId] : [])),
    ),
  ].flatMap((id) => props.byId.get(id) ?? []);
  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 items-center gap-2.5 self-start rounded-[18px] border px-3 py-1.5 text-left text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex -space-x-1.5" aria-hidden>
          {agents.slice(0, 6).map((a) => (
            <Familiar
              key={a.id}
              look={{ ...a.spec.avatar, mark: "none" }}
              size={20}
              ring="var(--background)"
            />
          ))}
        </span>
        <span>{open ? "Hide the discussion" : `The discussion: ${foldLabel(props.messages)}`}</span>
        {open ? (
          <ChevronDown className="size-4" aria-hidden />
        ) : (
          <ChevronRight className="size-4" aria-hidden />
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-6 border-l-2 pl-4">
          {props.messages.map(props.render)}
        </div>
      )}
    </div>
  );
}

/** The answer's first line of prose: headings ("**Answer**", "## Answer") are skipped. */
function answerLine(content: string): string {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const prose =
    lines.find((l) => !/^#{1,6}\s/.test(l) && !/^\*\*[^*]{1,40}\*\*:?$/.test(l)) ?? lines[0] ?? "";
  return prose
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The latest agreed answer, pinned above the chat; it jumps to the message. */
export function PinnedAnswer(props: {
  message: Message;
  agent: Agent | undefined;
  onShow: () => void;
}) {
  const line = answerLine(props.message.content);
  return (
    <button
      type="button"
      onClick={props.onShow}
      className="mx-auto flex w-full max-w-[820px] items-center gap-2.5 border-b px-4 py-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring md:px-8"
    >
      <Pin className="size-3.5 shrink-0" aria-hidden />
      <span className="eyebrow shrink-0 text-[11px] text-muted-foreground">Agreed answer</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{line}</span>
      <span className="hidden shrink-0 text-[12px] text-muted-foreground sm:inline">
        {props.agent ? `from ${props.agent.name}` : ""}
      </span>
    </button>
  );
}
