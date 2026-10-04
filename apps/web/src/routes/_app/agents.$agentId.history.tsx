import {
  useAgent,
  useAgentThread,
  useAgentThreads,
  useNewThread,
  useUpdateThread,
} from "@ofa/client";
import type { Agent, ThreadSummary } from "@ofa/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Archive, MessageSquare, Search, SquarePen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentPageHeader } from "@/components/agent-tabs";
import { ErrorAlert } from "@/components/ui/alert";
import { count, dayLabel, shortTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useDebounced, useVisible } from "@/lib/use-now";

// An agent's chats (UX.13): the current one first, then the rest by last use,
// grouped by day. Search covers every message; archiving has an Undo.

export const Route = createFileRoute("/_app/agents/$agentId/history")({
  staticData: { title: "History", fullBleed: true },
  component: HistoryPage,
});

function HistoryPage() {
  const { agentId } = Route.useParams();
  const { data: agent, error } = useAgent(agentId);
  if (error) {
    return (
      <div className="p-6">
        <ErrorAlert>{error.message}</ErrorAlert>
      </div>
    );
  }
  if (!agent) return <HistorySkeleton />;
  return <History agent={agent} />;
}

function HistorySkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading the history">
      <div className="h-16 border-b" />
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3 px-4 pt-6 md:px-8">
        <div className="skeleton h-11 w-full rounded-full" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-16 w-full rounded-[16px]" />
        ))}
      </div>
    </div>
  );
}

function History({ agent }: { agent: Agent }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const threads = useAgentThreads(agent.id, q);
  const { data: current } = useAgentThread(agent.id);
  const newThread = useNewThread(agent.id);
  const update = useUpdateThread();
  const items = threads.data?.pages.flatMap((p) => p.items) ?? [];
  const end = useRef<HTMLDivElement>(null);
  const atEnd = useVisible(end);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = threads;

  useEffect(() => {
    if (atEnd && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [atEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const startNew = () =>
    newThread.mutate(undefined, {
      onSuccess: () =>
        void navigate({ to: "/agents/$agentId", params: { agentId: agent.id }, search: {} }),
      onError: (e) => toast({ message: e.message, tone: "error" }),
    });

  const archive = (thread: ThreadSummary) =>
    update.mutate(
      { id: thread.id, patch: { archived: true } },
      {
        onSuccess: () =>
          toast({
            message: "Chat archived",
            action: {
              label: "Undo",
              onClick: () => update.mutate({ id: thread.id, patch: { archived: false } }),
            },
          }),
        onError: (e) => toast({ message: e.message, tone: "error" }),
      },
    );

  const newButton = (
    <button
      type="button"
      onClick={startNew}
      disabled={newThread.isPending}
      className="flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      <SquarePen className="size-4" aria-hidden /> New chat
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <AgentPageHeader agent={agent} current="history" action={newButton} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-4 pt-5 pb-16 md:px-8">
          <label className="relative block">
            <span className="sr-only">Search chats</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Search your chats with ${agent.name}`}
              className="h-11 w-full rounded-full border border-input bg-card pr-4 pl-10 text-[15px] outline-none placeholder:text-muted-foreground focus:border-ring/60"
            />
          </label>

          {threads.error && <ErrorAlert>{threads.error.message}</ErrorAlert>}
          {threads.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-16 w-full rounded-[16px]" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {q ? `No chat mentions “${q}”.` : "No chats yet."}
            </p>
          ) : (
            <ThreadList agent={agent} threads={items} currentId={current?.id} onArchive={archive} />
          )}
          <div ref={end} aria-hidden className="h-1" />
          {isFetchingNextPage && <div className="skeleton h-16 w-full rounded-[16px]" />}
        </div>
      </div>
    </div>
  );
}

function ThreadList({
  agent,
  threads,
  currentId,
  onArchive,
}: {
  agent: Agent;
  threads: readonly ThreadSummary[];
  currentId: string | undefined;
  onArchive: (thread: ThreadSummary) => void;
}) {
  const when = (t: ThreadSummary) => t.lastMessageAt ?? t.updatedAt;
  return (
    <ol className="flex flex-col">
      {threads.map((t, i) => {
        const day = dayLabel(when(t));
        const newDay = i === 0 || dayLabel(when(threads[i - 1]!)) !== day;
        const isCurrent = t.id === currentId;
        const title = t.title ?? t.preview ?? "New chat";
        return (
          <li key={t.id} className="flex flex-col">
            {newDay && (
              <span className="eyebrow px-1 pt-4 pb-2 text-[11px] text-muted-foreground">
                {day}
              </span>
            )}
            <div className="group flex items-center gap-1 rounded-[16px] hover:bg-accent focus-within:bg-accent">
              <Link
                to="/agents/$agentId"
                params={{ agentId: agent.id }}
                search={isCurrent ? {} : { thread: t.id }}
                className="flex min-w-0 flex-1 items-center gap-3.5 rounded-[16px] px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground">
                  <MessageSquare className="size-4" aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-semibold">{title}</span>
                    {isCurrent && (
                      <span className="eyebrow shrink-0 rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">
                        Current
                      </span>
                    )}
                  </span>
                  {t.title && t.preview && (
                    <span className="truncate text-[13px] text-muted-foreground">{t.preview}</span>
                  )}
                  <span className="font-mono text-[11.5px] text-muted-foreground">
                    {t.messageCount ? count(t.messageCount, "message") : "Empty"} ·{" "}
                    {shortTime(when(t))}
                  </span>
                </span>
              </Link>
              {t.messageCount > 0 && (
                <button
                  type="button"
                  onClick={() => onArchive(t)}
                  aria-label={`Archive “${title.slice(0, 40)}”`}
                  title="Archive"
                  className="mr-2 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-100 outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                >
                  <Archive className="size-4" aria-hidden />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
