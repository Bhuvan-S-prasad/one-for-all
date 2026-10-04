import {
  realtimeMessageSchema,
  type Agent,
  type Message,
  type RealtimeMessage,
  type Run,
  type RunEvent,
} from "@ofa/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./query";

// Apply live updates from `/api/ws` to the query cache (M2.20). Screens read
// the cache as usual and re-render; nothing polls.

function upsertBy<T>(
  list: readonly T[] | undefined,
  item: T,
  key: (x: T) => string,
  order?: (a: T, b: T) => number,
) {
  if (!list) return list;
  const next = [...list.filter((x) => key(x) !== key(item)), item];
  return order ? next.sort(order) : next;
}

export function applyRealtime(queryClient: QueryClient, message: RealtimeMessage): void {
  switch (message.type) {
    case "ready":
      return;
    case "run.event": {
      const event = message.event;
      queryClient.setQueryData<RunEvent[]>(queryKeys.runEvents(event.runId), (events) =>
        // Events can arrive out of order; the log order is `seq`.
        upsertBy(
          events,
          event,
          (e) => String(e.seq),
          (a, b) => a.seq - b.seq,
        ),
      );
      // Something was learned: the review lists change (UX.14).
      if (event.type === "memory.written") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.memoryLists });
      }
      return;
    }
    case "run.updated": {
      // Live updates leave out the request and reply previews; keep the known ones.
      const known = queryClient.getQueryData<Run>(queryKeys.run(message.run.id));
      const run: Run = {
        ...message.run,
        request: message.run.request ?? known?.request,
        reply: message.run.reply ?? known?.reply,
      };
      queryClient.setQueryData<Run>(queryKeys.run(run.id), run);
      let listed = false;
      for (const agentId of [undefined, run.agentId]) {
        queryClient.setQueryData<Run[]>(queryKeys.runs(agentId), (runs) => {
          if (!runs) return runs;
          const old = runs.find((r) => r.id === run.id);
          if (old) listed = true;
          return upsertBy(
            runs,
            { ...run, request: run.request ?? old?.request, reply: run.reply ?? old?.reply },
            (r) => r.id,
            (a, b) => b.createdAt.localeCompare(a.createdAt),
          );
        });
      }
      if (!listed) void queryClient.invalidateQueries({ queryKey: queryKeys.runLists });
      // Filtered Activity pages refetch when a status change can move a run between them.
      if (known?.status !== run.status) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.runSearches });
        if (run.status === "succeeded" || !known) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.agentStats });
        }
      }
      return;
    }
    case "message.created": {
      const m = message.message;
      queryClient.setQueryData<Message[]>(queryKeys.messages(m.threadId), (messages) =>
        upsertBy(
          messages,
          m,
          (x) => x.id,
          (a, b) => a.createdAt.localeCompare(b.createdAt),
        ),
      );
      // Chat lists show each chat's first message and order by last use.
      void queryClient.invalidateQueries({ queryKey: queryKeys.threadLists });
      return;
    }
    case "agent.updated": {
      const agent = message.agent;
      queryClient.setQueryData<Agent>(queryKeys.agent(agent.id), agent);
      queryClient.setQueryData<Agent[]>(queryKeys.agents, (agents) => {
        if (!agents) return agents;
        const next = agents.filter((a) => a.id !== agent.id);
        return agent.status === "archived"
          ? next
          : [...next, agent].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
      return;
    }
  }
}

export interface RealtimeConnection {
  close(): void;
}

/**
 * Keep a socket open, reconnecting with backoff. After a reconnect the cache
 * is refreshed, since updates may have been missed while offline.
 */
export function connectRealtime(options: {
  readonly url: string;
  readonly queryClient: QueryClient;
  readonly onStatus?: (status: "connecting" | "open" | "closed") => void;
}): RealtimeConnection {
  let socket: WebSocket | undefined;
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (stopped) return;
    options.onStatus?.("connecting");
    socket = new WebSocket(options.url);
    socket.onopen = () => {
      if (attempt > 0) void options.queryClient.invalidateQueries();
      attempt = 0;
      options.onStatus?.("open");
    };
    socket.onmessage = (event) => {
      const parsed = realtimeMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (parsed.success) applyRealtime(options.queryClient, parsed.data);
    };
    socket.onclose = () => {
      options.onStatus?.("closed");
      if (stopped) return;
      attempt += 1;
      timer = setTimeout(open, Math.min(30_000, 500 * 2 ** attempt));
    };
  };
  open();

  return {
    close() {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
