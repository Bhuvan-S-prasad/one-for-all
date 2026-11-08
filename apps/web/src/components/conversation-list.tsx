import { useAgents, useConversations } from "@ofa/client";
import type { Agent, Conversation, FamiliarMood } from "@ofa/contracts";
import { Link, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, Plus } from "lucide-react";
import { Familiar } from "@/components/familiar";
import { MOOD_WORDS, shouldAnimate, useAgentMoods } from "@/lib/agents";
import { groupName, rowPreview, rowState, rowTime } from "@/lib/conversations";
import { cn } from "@/lib/utils";

// The conversations (ADR-0052): every agent's current chat and every group,
// most recently active first. The sidebar on wide screens, the home screen on
// phones. Each row says who, when, the last thing said, and at most one state.

type Moods = ReturnType<typeof useAgentMoods>;

export function ConversationList({
  variant = "sidebar",
  onNavigate,
}: {
  variant?: "sidebar" | "page";
  /** Called when a row is chosen, e.g. to close a phone menu. */
  onNavigate?: () => void;
}) {
  const { data: agents } = useAgents();
  const { data: conversations, isPending, error } = useConversations();
  const moods = useAgentMoods(agents);
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (error) {
    return (
      <p role="alert" className="px-3 py-2 text-[13px] text-destructive">
        Couldn't load your conversations. {error.message}
      </p>
    );
  }
  if (isPending) {
    return (
      <div aria-busy="true" aria-label="Loading conversations" className="flex flex-col gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex h-16 items-center gap-3 px-2.5">
            <div className="skeleton size-10 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="skeleton h-3.5 w-24" />
              <div className="skeleton h-3 w-40" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  const rows = (conversations ?? []).filter(
    (c) => c.kind === "group" || (c.agentIds[0] && byId.has(c.agentIds[0])),
  );
  if (rows.length === 0) {
    return (
      <Link
        to="/agents/new"
        onClick={onNavigate}
        className="press mx-1 flex items-center gap-3 rounded-[14px] border border-dashed border-sidebar-border px-3 py-3.5 text-[13.5px] text-sidebar-muted outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Plus className="size-4 shrink-0" aria-hidden />
        No agents yet. Hatch your first one.
      </Link>
    );
  }
  return (
    <ul aria-label="Conversations" className="flex flex-col gap-0.5">
      {rows.map((c) => (
        <li key={c.threadId ?? `agent-${c.agentIds[0]}`}>
          <Row
            conversation={c}
            agents={byId}
            moods={moods}
            pathname={pathname}
            variant={variant}
            onNavigate={onNavigate}
          />
        </li>
      ))}
    </ul>
  );
}

function Row({
  conversation: c,
  agents,
  moods,
  pathname,
  variant,
  onNavigate,
}: {
  conversation: Conversation;
  agents: ReadonlyMap<string, Agent>;
  moods: Moods;
  pathname: string;
  variant: "sidebar" | "page";
  onNavigate?: () => void;
}) {
  const state = rowState(c);
  const preview = rowPreview(c, agents);
  const time = c.last ? rowTime(c.last.at) : null;
  const agent = c.kind === "direct" ? agents.get(c.agentIds[0] ?? "") : undefined;
  const mood: FamiliarMood = agent ? (moods.get(agent.id)?.mood ?? "idle") : "idle";
  const name = agent ? agent.name : groupName(c, agents);
  const current =
    c.kind === "direct"
      ? !!agent &&
        (pathname === `/agents/${agent.id}` || pathname.startsWith(`/agents/${agent.id}/`))
      : pathname === `/groups/${c.threadId}`;
  const busy = MOOD_WORDS[mood] === "Working";
  const label = [
    name,
    state === "action" ? "action needed" : null,
    state === "stuck" ? "stuck" : null,
    state === "unread" ? `${c.unread} unread` : null,
    busy ? "working" : null,
    time,
    preview,
  ]
    .filter(Boolean)
    .join(", ");

  const page = variant === "page";
  const muted = page ? "text-muted-foreground" : "text-sidebar-muted";
  const ring = page ? "var(--background)" : "var(--sidebar)";
  const className = cn(
    "press group relative flex items-center gap-3 rounded-[14px] px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-primary",
    page ? "h-[72px]" : "h-16",
    current
      ? page
        ? "bg-accent"
        : "bg-white/[0.07]"
      : page
        ? "hover:bg-accent/60"
        : "hover:bg-white/[0.04]",
  );
  const body = (
    <>
      {agent ? (
        <Familiar
          look={agent.spec.avatar}
          mood={mood}
          size={40}
          ring={ring}
          animate={shouldAnimate(mood)}
          className={cn("shrink-0", mood === "asleep" && "opacity-70")}
        />
      ) : (
        <GroupAvatar agentIds={c.agentIds} agents={agents} ring={ring} />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[15px] leading-tight",
              state === "unread" || state === "action" ? "font-bold" : "font-semibold",
              mood === "asleep" && muted,
            )}
          >
            {name}
          </span>
          {time && (
            <span className={cn("shrink-0 font-mono text-[11.5px] tabular-nums", muted)}>
              {time}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {state === "stuck" ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13.5px] text-destructive">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">Stopped. Open to see why</span>
            </span>
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13.5px]",
                state === "unread" ? (page ? "text-foreground" : "text-sidebar-foreground") : muted,
              )}
            >
              {busy ? <span className="text-highlight">Working… </span> : null}
              {preview}
            </span>
          )}
          <RowState state={state} unread={c.unread} />
        </span>
      </span>
    </>
  );

  if (c.kind === "direct" && agent) {
    return (
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.id }}
        search={{}}
        aria-label={label}
        aria-current={current ? "page" : undefined}
        onClick={onNavigate}
        className={className}
      >
        {body}
      </Link>
    );
  }
  return (
    <Link
      to="/groups/$threadId"
      params={{ threadId: c.threadId ?? "" }}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      onClick={onNavigate}
      className={className}
    >
      {body}
    </Link>
  );
}

function RowState({ state, unread }: { state: ReturnType<typeof rowState>; unread: number }) {
  if (state === "action") {
    return (
      <span
        title="Action needed"
        className="pip-in flex h-[18px] shrink-0 items-center rounded-full bg-primary px-1.5 text-[10.5px] font-bold whitespace-nowrap text-primary-foreground"
      >
        Needs you
      </span>
    );
  }
  if (state === "unread") {
    return (
      <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-info px-1 font-mono text-[10.5px] font-semibold text-background">
        {unread > 99 ? "99+" : unread}
      </span>
    );
  }
  return null;
}

/** Up to three members' familiars, overlapping, in a 40 px square. */
export function GroupAvatar({
  agentIds,
  agents,
  ring = "var(--sidebar)",
}: {
  agentIds: readonly string[];
  agents: ReadonlyMap<string, Agent>;
  ring?: string;
}) {
  const shown = agentIds.flatMap((id) => {
    const a = agents.get(id);
    return a ? [a] : [];
  });
  const [first, second, third] = shown;
  return (
    <span aria-hidden className="relative size-10 shrink-0">
      {first && (
        <Familiar
          look={first.spec.avatar}
          size={24}
          ring={ring}
          className="absolute top-0 left-2"
        />
      )}
      {second && (
        <Familiar
          look={second.spec.avatar}
          size={24}
          ring={ring}
          className="absolute bottom-0 left-0"
        />
      )}
      {third && (
        <Familiar
          look={third.spec.avatar}
          size={24}
          ring={ring}
          className="absolute right-0 bottom-0"
        />
      )}
    </span>
  );
}
