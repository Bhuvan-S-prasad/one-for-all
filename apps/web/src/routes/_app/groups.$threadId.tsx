import {
  moodFor,
  useAgents,
  useApprovals,
  useDiscussions,
  useMarkRead,
  useRun,
  useRuns,
  useSendMessage,
  useStopRun,
  useThread,
  useThreadMessages,
} from "@ofa/client";
import type { Agent, Discussion, Message, Run } from "@ofa/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowUp, Crown, Pin, Square } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { DiscussionBar, FoldedTurns, PinnedAnswer } from "@/components/chat/discussion";
import { LiveRun } from "@/components/chat/live-run";
import { Reply } from "@/components/chat/reply";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import {
  discussionRoles,
  foldTurns,
  isOpen,
  pinnedAnswer,
  type DiscussionRole,
} from "@/lib/discussions";
import { shortTime } from "@/lib/format";
import { insertMention, mentionQuery } from "@/lib/mentions";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

// A group chat (M5.04, M5.11): you and two to six agents. Each message gets
// one responder: the agent you @mention first, otherwise the coordinator,
// which answers or brings the others in. Every agent's reply shows its name
// and familiar. A message to @all starts a discussion (ADR-0050): a bar says
// whose turn it is, the turns fold away once it closes, and the agreed answer
// is pinned at the top.

export const Route = createFileRoute("/_app/groups/$threadId")({
  staticData: { title: "Group chat", fullBleed: true },
  component: GroupChat,
});

const ACTIVE = new Set(["queued", "running", "waiting"]);

function GroupChat() {
  const { threadId } = Route.useParams();
  const { data: thread, error } = useThread(threadId);
  const { data: messages, isPending } = useThreadMessages(threadId);
  const { data: agents } = useAgents();
  const { data: runs } = useRuns();
  const { data: approvals } = useApprovals();
  const { data: discussions } = useDiscussions(threadId);
  const send = useSendMessage(threadId);
  const stop = useStopRun();
  const now = useNow(true);
  useMarkRead(threadId, messages?.at(-1)?.id);

  const memberIds = (thread?.members ?? []).flatMap((m) => (m.type === "agent" ? [m.agentId] : []));
  const members = memberIds
    .map((id) => agents?.find((a) => a.id === id))
    .filter((a): a is Agent => !!a);
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const working = (runs ?? []).filter((r) => r.threadId === threadId && ACTIVE.has(r.status));
  const title =
    thread?.title ?? (members.length ? members.map((a) => a.name).join(", ") : "Group chat");
  const open = (discussions ?? []).find(isOpen) ?? null;
  const pinned = pinnedAnswer(discussions ?? []);
  const pinnedMessage = pinned
    ? (messages ?? []).find((m) => m.id === pinned.closingMessageId)
    : undefined;
  // "stop" ends a discussion too, between turns; Stop on one run wouldn't.
  const stopAll = () =>
    open
      ? void send.mutateAsync("stop").catch(() => {})
      : working.forEach((r) => stop.mutate(r.id));

  if (error) {
    return (
      <div className="p-6">
        <ErrorAlert>{error.message}</ErrorAlert>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4 md:px-6">
        <Link
          to="/"
          aria-label="Back to Home"
          className="flex size-9 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:hidden"
        >
          <ArrowLeft className="size-[18px]" aria-hidden />
        </Link>
        <div className="flex -space-x-2" aria-hidden>
          {members.slice(0, 6).map((a) => (
            <Familiar key={a.id} look={a.spec.avatar} size={30} ring="var(--background)" />
          ))}
        </div>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-[16px] font-bold">{title}</h1>
          <p className="truncate text-[12px] text-muted-foreground">
            {members
              .map((a) => (a.id === thread?.coordinatorAgentId ? `${a.name} (leads)` : a.name))
              .join(" · ")}
          </p>
        </div>
      </header>

      {pinnedMessage && (
        <PinnedAnswer
          message={pinnedMessage}
          agent={byId.get(pinned!.coordinatorAgentId)}
          onShow={() =>
            document
              .getElementById(`message-${pinnedMessage.id}`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        />
      )}

      <Messages
        loading={isPending}
        messages={messages ?? []}
        discussions={discussions ?? []}
        byId={byId}
        coordinatorId={thread?.coordinatorAgentId ?? null}
        tail={working.map((run) => {
          const agent = byId.get(run.agentId);
          return agent ? (
            <Working
              key={run.id}
              agent={agent}
              run={run}
              now={now}
              approvals={(approvals ?? []).filter((a) => a.runId === run.id)}
              stopping={stop.isPending}
              onStop={() => stop.mutate(run.id)}
            />
          ) : null;
        })}
      />

      {send.error && (
        <div className="mx-auto w-full max-w-[820px] px-4 md:px-8">
          <ErrorAlert>{send.error.message}</ErrorAlert>
        </div>
      )}
      {open && (
        <div className="mx-auto w-full max-w-[820px] px-4 md:px-8">
          <DiscussionBar discussion={open} byId={byId} stopping={send.isPending} onStop={stopAll} />
        </div>
      )}
      <GroupComposer
        members={members}
        busy={working.length > 0 || !!open}
        sending={send.isPending}
        onSend={(text) => send.mutateAsync(text).then(() => undefined)}
        onStop={stopAll}
      />
    </div>
  );
}

function Working(props: {
  agent: Agent;
  run: Run;
  now: number;
  approvals: Parameters<typeof LiveRun>[0]["approvals"];
  stopping: boolean;
  onStop: () => void;
}) {
  const { run: live, events } = useRun(props.run.id);
  const run = live.data ?? props.run;
  const lastEvent = events.data?.at(-1) ?? null;
  return (
    <LiveRun
      agent={props.agent}
      run={run}
      events={events.data ?? []}
      mood={moodFor({ agentStatus: props.agent.status, run, lastEvent, now: props.now })}
      now={props.now}
      approvals={props.approvals ?? []}
      stopping={props.stopping}
      onStop={props.onStop}
    />
  );
}

/** What an agent's message is in a discussion, beside its name. */
function DiscussionLabel({ role }: { role: DiscussionRole | undefined }) {
  if (role === "close") {
    return (
      <span className="eyebrow ml-1 flex items-center gap-1 text-[11px] text-foreground">
        <Pin className="size-3" aria-hidden />
        Agreed answer
      </span>
    );
  }
  if (role === "question") {
    return <span className="eyebrow ml-1 text-[11px]">Asked the group</span>;
  }
  if (role === "turn") return <span className="eyebrow ml-1 text-[11px]">Discussion</span>;
  return null;
}

function Messages(props: {
  loading: boolean;
  messages: readonly Message[];
  discussions: readonly Discussion[];
  byId: ReadonlyMap<string, Agent>;
  coordinatorId: string | null;
  tail: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = props.messages.at(-1)?.id;
  // Follow new messages while at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160 || !last) {
      el.scrollTop = el.scrollHeight;
    }
  }, [last, props.loading]);

  const roles = discussionRoles(props.discussions);
  const items = foldTurns(props.messages, roles);
  const render = (m: Message) => {
    const role = roles.get(m.id)?.role;
    if (m.author.type === "user") {
      return (
        <div
          key={m.id}
          id={`message-${m.id}`}
          className="flex max-w-[78%] flex-col items-end gap-1 self-end"
        >
          <div className="rounded-[20px_20px_6px_20px] border border-input bg-accent px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
            {m.content}
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            {role === "question" ? "Asked the group · " : ""}
            {shortTime(m.createdAt)}
          </span>
        </div>
      );
    }
    const agent = m.author.type === "agent" ? props.byId.get(m.author.agentId) : undefined;
    if (agent) {
      return (
        <div
          key={m.id}
          id={`message-${m.id}`}
          className={cn(
            "flex scroll-mt-14 flex-col gap-1.5",
            role === "close" && "rounded-[20px] border bg-card/60 px-4 pt-3 pb-1",
          )}
        >
          <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
            {agent.name}
            {agent.id === props.coordinatorId && (
              <Crown className="size-3.5" aria-label="leads the group" />
            )}
            <DiscussionLabel role={role} />
          </span>
          <Reply message={m} agent={agent} />
        </div>
      );
    }
    return (
      <div
        key={m.id}
        className="flex items-center gap-3 text-[12.5px] text-muted-foreground"
        role="note"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="max-w-[80%] text-center">{m.content}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  };

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <section
        aria-label="Conversation"
        className="mx-auto flex w-full max-w-[820px] flex-col gap-6 px-4 pt-6 pb-8 md:px-8"
      >
        {props.loading && (
          <div className="flex flex-col gap-5" aria-busy="true">
            <div className="skeleton h-12 w-2/3 self-end rounded-[20px]" />
            <div className="skeleton h-24 w-4/5 rounded-[22px]" />
          </div>
        )}
        {!props.loading && props.messages.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <h2 className="text-[22px] font-bold">Say hello to the group</h2>
            <p className="max-w-[440px] text-sm text-muted-foreground">
              Write @name to ask one agent. Otherwise{" "}
              {props.coordinatorId
                ? `${props.byId.get(props.coordinatorId)?.name ?? "the coordinator"} answers`
                : "the coordinator answers"}{" "}
              and brings in the others when it needs them. Write @all to hear everyone in turn.
            </p>
          </div>
        )}
        {items.map((item) =>
          item.kind === "turns" ? (
            <FoldedTurns
              key={`turns-${item.messages[0]!.id}`}
              messages={item.messages}
              byId={props.byId}
              render={render}
            />
          ) : (
            render(item.message)
          ),
        )}
        {props.tail}
      </section>
    </div>
  );
}

function GroupComposer(props: {
  members: readonly Agent[];
  busy: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const typed = mentionQuery(text);
  const matches =
    typed === null
      ? []
      : props.members.filter(
          (a) => a.slug.startsWith(typed) || a.name.toLowerCase().startsWith(typed),
        );
  const picking = matches.length > 0 && dismissedAt !== text;
  const active = Math.min(picked, Math.max(0, matches.length - 1));

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  useEffect(() => area.current?.focus(), []);

  const pick = (agent: Agent) => {
    setText((t) => insertMention(t, agent.name));
    setPicked(0);
    area.current?.focus();
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = text.trim();
    if (!content || props.sending) return;
    setText("");
    try {
      await props.onSend(content);
    } catch {
      setText(content);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picking) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setPicked((active + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        pick(matches[active]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(text);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      void submit(event);
    }
  };
  const showStop = props.busy && !text.trim();

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-[820px] px-4 pt-2 pb-4 md:px-8 md:pb-5">
      <label htmlFor="group-message" className="sr-only">
        Message the group
      </label>
      <div className="relative flex items-end gap-2 rounded-[26px] border border-input bg-card p-2 pl-4 focus-within:border-ring/60">
        {picking && (
          <ul
            id="member-suggestions"
            role="listbox"
            aria-label="Members"
            className="absolute right-2 bottom-full left-2 mb-2 overflow-hidden rounded-[18px] border bg-popover p-1.5 text-popover-foreground shadow-xl"
          >
            {matches.map((agent, i) => (
              <li
                key={agent.id}
                id={`member-suggestions-${i}`}
                role="option"
                aria-selected={i === active}
                onPointerMove={() => setPicked(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(agent)}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-[12px] px-3",
                  i === active && "bg-accent",
                )}
              >
                <Familiar look={agent.spec.avatar} size={26} ring="var(--popover)" />
                <span className="flex-1 truncate text-[14px]">{agent.name}</span>
                <span className="truncate text-[12.5px] text-muted-foreground">
                  {agent.spec.job}
                </span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          id="group-message"
          ref={area}
          rows={1}
          role="combobox"
          aria-expanded={picking}
          aria-controls={picking ? "member-suggestions" : undefined}
          aria-activedescendant={picking ? `member-suggestions-${active}` : undefined}
          aria-autocomplete="list"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Message the group. @name asks one agent, @all asks everyone"
          className="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent py-2 text-[15.5px] leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        {showStop ? (
          <button
            type="button"
            onClick={props.onStop}
            aria-label="Stop the agents working here"
            className="flex size-11 shrink-0 items-center justify-center rounded-full border-[1.5px] border-foreground text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Square className="size-3.5 fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={props.sending || !text.trim()}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:bg-accent disabled:text-muted-foreground"
          >
            <ArrowUp className="size-5" aria-hidden />
          </button>
        )}
      </div>
    </form>
  );
}
