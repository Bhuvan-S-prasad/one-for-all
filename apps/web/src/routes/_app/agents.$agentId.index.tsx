import {
  MOOD_LABELS,
  moodFor,
  useAgent,
  useAgents,
  useApprovals,
  useMarkRead,
  useSkills,
  useChatThread,
  useNewThread,
  useRun,
  useRuns,
  useSendMessage,
  useStopRun,
  useThreadMessages,
  useUpdateAgent,
} from "@ofa/client";
import type { Agent, FamiliarMood, Message, Run } from "@ofa/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Activity as ActivityIcon,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  History,
  Lightbulb,
  Monitor,
  PanelRight,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Square,
  SquarePen,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useUnconfirmedCount } from "@/components/agent-tabs";
import { ChatMenu, type ChatMenuItem } from "@/components/chat/chat-menu";
import {
  AttachButton,
  PendingAttachments,
  SentAttachments,
  useAttachments,
} from "@/components/chat/attachments";
import { LiveRun, WorkingRing } from "@/components/chat/live-run";
import { Reply } from "@/components/chat/reply";
import { RunPanel } from "@/components/chat/run-panel";
import {
  insertSkill,
  matchSkills,
  SkillSuggestions,
  skillQuery,
} from "@/components/chat/skill-picker";
import { ComputerOverlay, ComputerPanel, usesComputer } from "@/components/computer/computer-panel";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import { starters } from "@/lib/agents";
import { splitAttachments } from "@/lib/attachments";
import { duration, shortTime } from "@/lib/format";
import { runPhase } from "@/lib/run-steps";
import { isTyping, useStoredFlag } from "@/lib/shortcuts";
import { toast } from "@/lib/toast";
import { useNow } from "@/lib/use-now";
import { useWide } from "@/lib/use-wide";
import { cn } from "@/lib/utils";

// The chat (UX.05): a compact header, a thread that scrolls on its own, the
// live run at the bottom of the thread (UX.07), and a composer whose Send
// turns into Stop while the agent works. Wide screens show the run beside it.

export const Route = createFileRoute("/_app/agents/$agentId/")({
  staticData: { title: "Chat", fullBleed: true },
  // `thread`: a chat picked from the history (UX.13); none means the current one.
  validateSearch: (search: Record<string, unknown>): { draft?: string; thread?: string } => ({
    ...(typeof search.draft === "string" && search.draft
      ? { draft: search.draft.slice(0, 4_000) }
      : {}),
    ...(typeof search.thread === "string" && /^[\w-]{1,64}$/.test(search.thread)
      ? { thread: search.thread }
      : {}),
  }),
  component: AgentChatPage,
});

const ACTIVE = new Set(["queued", "running", "waiting"]);

function AgentChatPage() {
  const { agentId } = Route.useParams();
  const { data: agent, error } = useAgent(agentId);
  if (error) {
    return (
      <div className="p-6">
        <ErrorAlert>{error.message}</ErrorAlert>
      </div>
    );
  }
  if (!agent) return <ChatSkeleton />;
  return <Chat key={agent.id} agent={agent} />;
}

/** The chat's shape while it loads, so nothing jumps when it arrives. */
function ChatSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading the chat">
      <div className="flex h-16 items-center gap-3 border-b px-6">
        <div className="skeleton size-10 rounded-full" />
        <div className="flex flex-col gap-2">
          <div className="skeleton h-4 w-28" />
          <div className="skeleton h-3 w-48" />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-6 pt-8">
        <div className="skeleton h-12 w-2/3 self-end rounded-[20px]" />
        <div className="skeleton h-28 w-4/5 rounded-[22px]" />
        <div className="skeleton h-12 w-1/2 self-end rounded-[20px]" />
      </div>
    </div>
  );
}

function Chat({ agent }: { agent: Agent }) {
  const navigate = useNavigate();
  const { draft, thread: threadId } = Route.useSearch();
  const { data: thread, error: threadError } = useChatThread(agent.id, threadId);
  const { data: messages, isPending: loadingMessages } = useThreadMessages(thread?.id);
  // Seen while it is on screen (M5.11 unread).
  useMarkRead(thread?.id, messages?.at(-1)?.id);
  const { data: runs } = useRuns(agent.id);
  // The run shown in the thread is this chat's latest; the agent may be busy
  // in another chat, which the header and a notice say.
  const latest = runs?.[0];
  // A follow-up that the working run read (steering, M5.05) ends without a
  // run of its own; the run that read it is the one to show.
  const threadRun = thread
    ? runs?.find((r) => r.threadId === thread.id && r.error?.code !== "steered")
    : undefined;
  const { run: liveRun, events } = useRun(threadRun?.id);
  const run: Run | undefined = liveRun.data ?? threadRun;
  const active = !!run && ACTIVE.has(run.status);
  const { data: approvals } = useApprovals(agent.id);
  const waitingOnYou = approvals?.filter((a) => a.runId === run?.id) ?? [];
  const busyElsewhere = !!latest && latest.id !== run?.id && ACTIVE.has(latest.status);
  const now = useNow(active);
  const lastEvent = events.data?.at(-1) ?? null;
  const mood = moodFor({
    agentStatus: agent.status,
    run: active || !busyElsewhere ? run : latest,
    lastEvent: active ? lastEvent : null,
    now,
  });
  const send = useSendMessage(thread?.id);
  const stop = useStopRun();
  const update = useUpdateAgent(agent.id);
  const newThread = useNewThread(agent.id);
  const [panelOpen, setPanelOpen] = useStoredFlag("ofa-run-panel", true);
  // The agent's computer (M3.10): a side panel on wide screens, full screen on phones.
  const [computerOpen, setComputerOpen] = useStoredFlag("ofa-computer-panel", false);
  const [overlay, setOverlay] = useState<null | "watch" | "control">(null);
  const hasComputer = usesComputer(agent);
  // The side panel exists only on wide screens; phones use the full-screen view.
  const wide = useWide();
  const panelShown = hasComputer && computerOpen && wide;
  const celebrate = useJustFinished(run);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const clearDraft = useCallback(
    () =>
      void navigate({
        to: "/agents/$agentId",
        params: { agentId: agent.id },
        search: threadId ? { thread: threadId } : {},
        replace: true,
      }),
    [navigate, agent.id, threadId],
  );

  const stopRun = useCallback(() => {
    if (run && active && !stop.isPending) stop.mutate(run.id);
  }, [run, active, stop]);

  // A fresh chat: the old one stays in History, and old topics stay out of new tasks.
  const startNewChat = useCallback(() => {
    if (newThread.isPending) return;
    newThread.mutate(undefined, {
      onSuccess: () => {
        void navigate({ to: "/agents/$agentId", params: { agentId: agent.id }, search: {} });
        composerRef.current?.focus();
      },
      onError: (error) => toast({ message: error.message, tone: "error" }),
    });
  }, [newThread, navigate, agent.id]);

  const togglePause = () => {
    const before = agent.status;
    const next = before === "active" ? "paused" : "active";
    update.mutate(
      { status: next },
      {
        onSuccess: () =>
          toast({
            message: next === "paused" ? `${agent.name} paused` : `${agent.name} resumed`,
            action: { label: "Undo", onClick: () => update.mutate({ status: before }) },
          }),
        onError: (error) => toast({ message: error.message, tone: "error" }),
      },
    );
  };

  // "/" writes a message; N starts a new chat; Escape stops a working agent
  // (unless a menu is open).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/" && !isTyping(event.target)) {
        event.preventDefault();
        composerRef.current?.focus();
      } else if (event.key.toLowerCase() === "n" && !isTyping(event.target)) {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        startNewChat();
      } else if (
        event.key === "Escape" &&
        active &&
        (event.target === composerRef.current || !isTyping(event.target)) &&
        !document.querySelector('[role="dialog"]')
      ) {
        stopRun();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, stopRun, startNewChat]);

  const sendText = (text: string, uploads: readonly string[] = []) =>
    send.mutateAsync({ content: text, uploads }).then(() => {
      // Writing in an older chat makes it the current one.
      if (threadId) {
        void navigate({
          to: "/agents/$agentId",
          params: { agentId: agent.id },
          search: {},
          replace: true,
        });
      }
    });
  const visible = (messages ?? []).filter((m) => m.author.type !== "system" || m.content.trim());
  // The run that last started (or answered) has finished without a reply.
  const lastUser = [...visible].reverse().find((m) => m.author.type === "user");
  const answered = !!run && visible.some((m) => m.author.type === "agent" && m.runId === run.id);
  const failedUnanswered = !!run && run.status === "failed" && !answered;
  const stoppedUnanswered = !!run && run.status === "cancelled" && !answered;
  const showPanel = panelOpen && !!run && (events.data?.length ?? 0) > 0;
  const lastReply = [...visible].reverse().find((m) => m.author.type === "agent");

  if (threadError) {
    return (
      <div className="p-6">
        <ErrorAlert>
          {threadError.message}{" "}
          <Link
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            search={{}}
            className="underline"
          >
            Open the current chat
          </Link>
        </ErrorAlert>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        agent={agent}
        mood={mood}
        run={run}
        active={active}
        now={now}
        celebrate={celebrate}
        pausing={update.isPending}
        onPause={togglePause}
        onNewChat={startNewChat}
        canStartNew={visible.length > 0 && !newThread.isPending}
        panelOpen={panelOpen}
        onTogglePanel={run ? () => setPanelOpen(!panelOpen) : undefined}
        computerOpen={panelShown}
        onComputer={
          hasComputer
            ? () => {
                // Wide screens get the side panel; phones the full-screen view.
                if (wide) setComputerOpen(!computerOpen);
                else setOverlay("watch");
              }
            : undefined
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Thread
            agent={agent}
            messages={visible}
            loading={loadingMessages && !!thread}
            follow={[visible.length, active, events.data?.length ?? 0, run?.status]}
            onStarter={(text) => void sendText(text)}
            onRetryFor={(message) => {
              const asked = previousUserMessage(visible, message);
              return asked ? () => void sendText(asked.content) : undefined;
            }}
            continueFor={(message) =>
              message.id === lastReply?.id && !active
                ? () => void sendText("Please continue where you left off.")
                : undefined
            }
            tail={
              <>
                {busyElsewhere && !active && (
                  <Notice>
                    {agent.name} is working in another chat. A message here waits its turn.
                  </Notice>
                )}
                {active && run && (
                  <LiveRun
                    agent={agent}
                    run={run}
                    events={events.data ?? []}
                    mood={mood}
                    now={now}
                    stopping={stop.isPending}
                    onStop={stopRun}
                    approvals={waitingOnYou}
                  />
                )}
                {failedUnanswered && run && (
                  <FailedRun
                    agent={agent}
                    run={run}
                    onRetry={lastUser ? () => void sendText(lastUser.content) : undefined}
                  />
                )}
                {stoppedUnanswered && run?.endedAt && (
                  <Notice>
                    You stopped {agent.name} · {shortTime(run.endedAt)}
                  </Notice>
                )}
              </>
            }
          />
          {send.error && (
            <div className="mx-auto w-full max-w-[820px] px-4 md:px-8">
              <ErrorAlert>{send.error.message}</ErrorAlert>
            </div>
          )}
          <Composer
            ref={composerRef}
            agent={agent}
            initial={draft}
            onDraftUsed={clearDraft}
            threadId={thread?.id}
            disabled={!thread}
            sending={send.isPending}
            active={active}
            stopping={stop.isPending}
            resuming={update.isPending}
            onSend={sendText}
            onStop={stopRun}
            onResume={togglePause}
          />
        </div>
        {panelShown ? (
          <ComputerPanel
            agent={agent}
            onClose={() => setComputerOpen(false)}
            onTakeOver={() => setOverlay("control")}
          />
        ) : (
          showPanel &&
          run && (
            <RunPanel
              agent={agent}
              run={run}
              events={events.data ?? []}
              active={active}
              now={now}
            />
          )
        )}
        {overlay && (
          <ComputerOverlay
            agent={agent}
            initialControl={overlay === "control"}
            onClose={() => setOverlay(null)}
          />
        )}
      </div>
    </div>
  );
}

function previousUserMessage(messages: readonly Message[], reply: Message): Message | undefined {
  const index = messages.findIndex((m) => m.id === reply.id);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i]?.author.type === "user") return messages[i];
  }
  return undefined;
}

/** True for a moment after the latest run succeeds: the familiar hops once. */
function useJustFinished(run: Run | undefined): boolean {
  const [hop, setHop] = useState(false);
  const previous = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = run ? { id: run.id, status: run.status } : null;
    if (run && before?.id === run.id && ACTIVE.has(before.status) && run.status === "succeeded") {
      setHop(true);
      const timer = setTimeout(() => setHop(false), 1_000);
      return () => clearTimeout(timer);
    }
  }, [run]);
  return hop;
}

// ── Header ───────────────────────────────────────────────────────────────────

function ChatHeader(props: {
  agent: Agent;
  mood: FamiliarMood;
  run: Run | undefined;
  active: boolean;
  now: number;
  celebrate: boolean;
  pausing: boolean;
  onPause: () => void;
  onNewChat: () => void;
  canStartNew: boolean;
  panelOpen: boolean;
  onTogglePanel?: () => void;
  computerOpen: boolean;
  onComputer?: () => void;
}) {
  const { agent, mood, run, active } = props;
  const phase = active && run ? runPhase(run.status, []) : null;
  const elapsed =
    active && run ? duration(props.now - Date.parse(run.startedAt ?? run.createdAt)) : null;
  const paused = agent.status !== "active";
  // Said only when there is something to say: working, paused or stuck.
  const status = paused
    ? "Paused"
    : mood === "idle"
      ? null
      : `${MOOD_LABELS[mood]}${elapsed ? ` · ${elapsed}` : ""}`;
  const params = { agentId: agent.id };
  const unconfirmed = useUnconfirmedCount(agent.id);
  const items: ChatMenuItem[] = [
    {
      kind: "action",
      label: "New chat",
      icon: SquarePen,
      hint: "N",
      onSelect: props.onNewChat,
      disabled: !props.canStartNew,
    },
    { kind: "link", label: "Chat history", icon: History, to: "/agents/$agentId/history", params },
    {
      kind: "link",
      label: unconfirmed > 0 ? `Memory · ${unconfirmed} new` : "Memory",
      icon: Lightbulb,
      to: "/agents/$agentId/memory",
      params,
    },
    {
      kind: "link",
      label: "Activity",
      icon: ActivityIcon,
      to: "/activity",
      search: { agent: agent.id },
    },
    ...(props.onTogglePanel
      ? [
          {
            kind: "action" as const,
            label: props.panelOpen ? "Hide the steps" : "Show the steps",
            icon: PanelRight,
            onSelect: props.onTogglePanel,
            wideOnly: true,
          },
        ]
      : []),
    { kind: "divider" },
    { kind: "link", label: "Agent settings", icon: Settings2, to: "/agents/$agentId/edit", params },
    {
      kind: "action",
      label: paused ? `Resume ${agent.name}` : `Pause ${agent.name}`,
      icon: paused ? Play : Pause,
      onSelect: props.onPause,
      disabled: props.pausing || agent.status === "archived",
    },
  ];

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-2 md:gap-3 md:px-6">
      <Link
        to="/"
        aria-label="Back to chats"
        className="press flex size-10 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      >
        <ArrowLeft className="size-5" aria-hidden />
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="relative size-10 shrink-0">
          {active && <WorkingRing kind={phase?.kind ?? "thinking"} />}
          <Familiar
            key={props.celebrate ? "hop" : "still"}
            look={agent.spec.avatar}
            mood={mood}
            size={30}
            ring="var(--background)"
            animate
            celebrate={props.celebrate}
            label={`${agent.name}'s familiar, ${MOOD_LABELS[mood].toLowerCase()}`}
            className="absolute top-[5px] left-[5px]"
          />
        </div>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-[17px] leading-tight font-semibold tracking-[-0.01em]">
            {agent.name}
          </h1>
          {status && (
            <span
              className={cn(
                "flex items-center gap-1.5 truncate text-[12.5px]",
                mood === "error"
                  ? "text-destructive"
                  : mood === "waiting"
                    ? "text-warning"
                    : paused || mood === "asleep"
                      ? "text-muted-foreground"
                      : "text-highlight",
              )}
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
              {status}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {props.onComputer && (
          <button
            type="button"
            onClick={props.onComputer}
            aria-pressed={props.computerOpen}
            aria-label={props.computerOpen ? "Hide the computer" : "Show the computer"}
            title="Computer: watch or take over its browser"
            className={cn(
              "flex size-10 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              props.computerOpen ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Monitor className="size-[18px]" aria-hidden />
          </button>
        )}
        <ChatMenu label={`${agent.name}: more`} items={items} />
      </div>
    </header>
  );
}

// ── Thread ───────────────────────────────────────────────────────────────────

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground" role="note">
      <span className="h-px flex-1 bg-border" />
      <span className="max-w-[80%] text-center">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function FailedRun({ agent, run, onRetry }: { agent: Agent; run: Run; onRetry?: () => void }) {
  return (
    <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-3">
      <Familiar look={{ ...agent.spec.avatar, mark: "none" }} mood="error" size={36} animate />
      <div className="flex flex-col gap-2.5 rounded-[18px] border border-destructive/30 bg-destructive-surface/40 px-4 py-3.5">
        <span className="text-[14.5px] font-semibold">{agent.name} couldn't finish</span>
        <span className="text-[13.5px] leading-snug text-muted-foreground">
          {run.error?.message ?? "Something went wrong."} Nothing was sent or changed. Trying again
          usually works.
        </span>
        <div className="flex flex-wrap gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw className="size-4" aria-hidden /> Try again
            </button>
          )}
          <Link
            to="/activity"
            search={{ run: run.id }}
            className="flex h-9 items-center rounded-full border border-input px-4 text-[13px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            See what happened
          </Link>
        </div>
      </div>
    </div>
  );
}

function Thread(props: {
  agent: Agent;
  messages: readonly Message[];
  loading: boolean;
  /** Changes in these keep the view at the bottom, if it was there. */
  follow: readonly unknown[];
  tail: React.ReactNode;
  onStarter: (text: string) => void;
  onRetryFor: (message: Message) => (() => void) | undefined;
  continueFor: (message: Message) => (() => void) | undefined;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  /** Follow new content: true at the bottom, false once someone scrolls up to read. */
  const following = useRef(true);
  /** Our own scrolling, which must not count as someone scrolling away. */
  const ownScroll = useRef(0);
  const [behind, setBehind] = useState(false);
  const first = useRef(true);
  const last = props.messages.at(-1);
  // Another agent can answer here when this one messaged it (M5.03): show who wrote it.
  const { data: everyone } = useAgents();
  const authorOf = (m: Message): Agent | undefined =>
    m.author.type === "agent" && m.author.agentId !== props.agent.id
      ? everyone?.find((a) => a.id === (m.author as { agentId: string }).agentId)
      : undefined;

  const toBottom = (smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    following.current = true;
    setBehind(false);
    ownScroll.current = Date.now() + (smooth ? 700 : 80);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  // New messages follow only someone already at the bottom (or who just
  // sent one); anyone reading further up gets "Jump to latest" instead of
  // being dragged down.
  useLayoutEffect(() => {
    if (props.loading) return;
    if (first.current) {
      first.current = false;
      toBottom(false);
      return;
    }
    if (following.current || last?.author.type === "user") toBottom(false);
    else setBehind(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `follow` lists what to react to.
  }, [props.loading, last?.id, ...props.follow]);

  // Content that grows in place (a reply loading its sources, a new live
  // step) keeps a following view pinned to the bottom.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!following.current) return;
      ownScroll.current = Date.now() + 80;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || Date.now() < ownScroll.current) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (following.current) setBehind(false);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto">
        <section
          ref={content}
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
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Familiar look={props.agent.spec.avatar} size={84} animate ring="var(--background)" />
              <h2 className="text-[22px] font-bold">{props.agent.name} is ready</h2>
              <p className="max-w-[420px] text-sm text-muted-foreground">{props.agent.spec.job}</p>
              {props.agent.status === "active" && (
                <div className="mt-2 flex w-full max-w-[420px] flex-col gap-2">
                  {starters(props.agent).map((text) => (
                    <button
                      key={text}
                      type="button"
                      onClick={() => props.onStarter(text)}
                      className="flex min-h-11 items-center rounded-[14px] border px-4 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {text}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {props.messages.map((m) =>
            m.author.type === "user" ? (
              <div key={m.id} className="flex max-w-[78%] flex-col items-end gap-1 self-end">
                <UserMessage content={m.content} />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {shortTime(m.createdAt)}
                </span>
              </div>
            ) : m.author.type === "agent" ? (
              authorOf(m) ? (
                <Reply key={m.id} message={m} agent={authorOf(m)!} />
              ) : (
                <Reply
                  key={m.id}
                  message={m}
                  agent={props.agent}
                  onRetry={props.onRetryFor(m)}
                  onContinue={props.continueFor(m)}
                />
              )
            ) : (
              <Notice key={m.id}>{m.content}</Notice>
            ),
          )}
          {props.tail}
        </section>
      </div>
      {behind && (
        <button
          type="button"
          onClick={() => {
            toBottom(true);
            setBehind(false);
          }}
          className="absolute bottom-4 left-1/2 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-semibold text-background shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <ArrowDown className="size-4" aria-hidden /> Jump to latest
        </button>
      )}
    </div>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────

function Composer(props: {
  ref: React.Ref<HTMLTextAreaElement>;
  agent: Agent;
  initial?: string;
  onDraftUsed: () => void;
  threadId: string | undefined;
  disabled: boolean;
  sending: boolean;
  active: boolean;
  stopping: boolean;
  resuming: boolean;
  onSend: (text: string, uploads?: readonly string[]) => Promise<void>;
  onStop: () => void;
  onResume: () => void;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const local = useRef<HTMLTextAreaElement | null>(null);
  // Files to send with the message (EN.09).
  const attachments = useAttachments(props.threadId);
  const { initial, onDraftUsed } = props;
  // `/` names one of the agent's skills (M5.08).
  const { data: skills } = useSkills(props.agent.id);
  const typed = skillQuery(text);
  const matches = typed === null ? [] : matchSkills(skills ?? [], typed);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [picked, setPicked] = useState(0);
  const picking = matches.length > 0 && dismissedAt !== text;
  const activeSkill = Math.min(picked, Math.max(0, matches.length - 1));
  const pickSkill = (slug: string) => {
    setText((current) => insertSkill(current, slug));
    setPicked(0);
    local.current?.focus();
  };

  // A message started elsewhere (⌘K "Ask …") arrives ready to send.
  useEffect(() => {
    if (!initial) return;
    local.current?.focus();
    onDraftUsed();
  }, [initial, onDraftUsed]);

  // Grow with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = local.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  if (props.agent.status !== "active") {
    return (
      <div className="mx-auto w-full max-w-[820px] px-4 pt-2 pb-4 md:px-8 md:pb-6">
        <div className="flex items-center gap-3 rounded-[24px] border border-dashed border-input bg-card px-4 py-2.5">
          <span className="flex-1 text-sm text-muted-foreground">
            {props.agent.name} is {props.agent.status}, so it won't reply or run routines.
          </span>
          {props.agent.status === "paused" && (
            <button
              type="button"
              onClick={props.onResume}
              disabled={props.resuming}
              className="flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <Play className="size-4" aria-hidden /> Resume
            </button>
          )}
        </div>
      </div>
    );
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = text.trim();
    const uploads = attachments.ready;
    if ((!content && uploads.length === 0) || props.disabled || props.sending) return;
    if (attachments.uploading) return;
    setText("");
    attachments.clear();
    try {
      await props.onSend(content, uploads);
    } catch {
      setText(content); // Keep what they wrote if it didn't send.
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picking) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setPicked((activeSkill + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        pickSkill(matches[activeSkill]!.slug);
        return;
      }
      if (event.key === "Escape") {
        // Closes the list; it doesn't stop the agent.
        event.preventDefault();
        setDismissedAt(text);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)
      void submit(event);
  };
  const showStop = props.active && !text.trim() && attachments.items.length === 0;
  const canSend = (!!text.trim() || attachments.ready.length > 0) && !attachments.uploading;

  return (
    <form
      onSubmit={submit}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        attachments.add(e.dataTransfer.files);
      }}
      className="mx-auto w-full max-w-[820px] px-4 pt-2 pb-4 md:px-8 md:pb-5"
    >
      <PendingAttachments items={attachments.items} onRemove={attachments.remove} />
      <label htmlFor="message" className="sr-only">
        Message {props.agent.name}
      </label>
      <div className="relative flex items-end gap-1 rounded-[26px] border border-input bg-card p-2 pl-1.5 focus-within:border-ring/60">
        <AttachButton onFiles={attachments.add} disabled={props.disabled || !props.threadId} />
        {picking && (
          <SkillSuggestions
            id="skill-suggestions"
            items={matches}
            active={activeSkill}
            onPick={(skill) => pickSkill(skill.slug)}
            onHover={setPicked}
          />
        )}
        <textarea
          id="message"
          ref={(el) => {
            local.current = el;
            if (typeof props.ref === "function") props.ref(el);
            else if (props.ref)
              (props.ref as React.RefObject<HTMLTextAreaElement | null>).current = el;
          }}
          rows={1}
          role="combobox"
          aria-expanded={picking}
          aria-controls={picking ? "skill-suggestions" : undefined}
          aria-activedescendant={picking ? `skill-suggestions-${activeSkill}` : undefined}
          aria-autocomplete="list"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            if (e.clipboardData.files.length === 0) return;
            e.preventDefault();
            attachments.add(e.clipboardData.files);
          }}
          disabled={props.disabled}
          placeholder={
            props.active
              ? `Add to the conversation. ${props.agent.name} reads it at its next step`
              : `Message ${props.agent.name}`
          }
          className="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent py-2 text-[15.5px] leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        {showStop ? (
          <button
            type="button"
            onClick={props.onStop}
            disabled={props.stopping}
            aria-label={`Stop ${props.agent.name}`}
            title="Stop (Esc)"
            className="flex size-11 shrink-0 items-center justify-center rounded-full border-[1.5px] border-foreground text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Square className="size-3.5 fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={props.disabled || props.sending || !canSend}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:bg-accent disabled:text-muted-foreground"
          >
            <ArrowUp className="size-5" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-1.5 hidden gap-4 px-4 font-mono text-[11px] text-muted-foreground md:flex">
        <span>↵ send</span>
        <span>⇧↵ new line</span>
        <span>/ to write from anywhere</span>
        {(skills?.length ?? 0) > 0 && <span>/name for a skill</span>}
        {props.active && <span className="ml-auto">Esc stops {props.agent.name}</span>}
      </div>
    </form>
  );
}

/** A person's message: its text, and the files attached to it (EN.09). */
function UserMessage({ content }: { content: string }) {
  const { text, files } = useMemo(() => splitAttachments(content), [content]);
  return (
    <>
      {files.length > 0 && <SentAttachments files={files} />}
      {text && (
        <div className="rounded-[20px_20px_6px_20px] border border-input bg-accent px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      )}
    </>
  );
}
