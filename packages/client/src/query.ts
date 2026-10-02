import { QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "./api-client";

export const queryKeys = {
  session: ["session"] as const,
  setupStatus: ["setup-status"] as const,
  health: ["health"] as const,
  agents: ["agents"] as const,
  agent: (id: string) => ["agents", id] as const,
  agentThread: (id: string) => ["agents", id, "thread"] as const,
  messages: (threadId: string) => ["threads", threadId, "messages"] as const,
  runs: (agentId?: string) => ["runs", "list", agentId ?? "all"] as const,
  runLists: ["runs", "list"] as const,
  run: (id: string) => ["runs", id] as const,
  runEvents: (id: string) => ["runs", id, "events"] as const,
  llmSettings: ["settings", "llm"] as const,
};

/** Shared by hooks and router loaders, so both read the same cache entry. */
export const sessionQuery = (api: ApiClient) =>
  queryOptions({ queryKey: queryKeys.session, queryFn: () => api.session(), staleTime: 60_000 });

export const setupStatusQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: queryKeys.setupStatus,
    queryFn: () => api.setupStatus(),
    staleTime: Infinity,
  });

/** Server health; refreshed every 30 seconds while shown. */
export const healthQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: queryKeys.health,
    queryFn: () => api.health(),
    refetchInterval: 30_000,
    retry: false,
  });

// Live data below is kept fresh by the realtime socket (`useRealtimeSync`),
// so it does not poll.

export const agentsQuery = (api: ApiClient) =>
  queryOptions({ queryKey: queryKeys.agents, queryFn: async () => (await api.listAgents()).items });

export const agentQuery = (api: ApiClient, id: string) =>
  queryOptions({ queryKey: queryKeys.agent(id), queryFn: () => api.getAgent(id) });

export const agentThreadQuery = (api: ApiClient, agentId: string) =>
  queryOptions({
    queryKey: queryKeys.agentThread(agentId),
    queryFn: () => api.agentThread(agentId),
    staleTime: Infinity,
  });

export const messagesQuery = (api: ApiClient, threadId: string) =>
  queryOptions({
    queryKey: queryKeys.messages(threadId),
    queryFn: async () => (await api.listMessages(threadId, { limit: 100 })).items,
  });

export const runsQuery = (api: ApiClient, agentId?: string) =>
  queryOptions({
    queryKey: queryKeys.runs(agentId),
    queryFn: async () => (await api.listRuns({ agentId, limit: 50 })).items,
  });

export const runQuery = (api: ApiClient, id: string) =>
  queryOptions({ queryKey: queryKeys.run(id), queryFn: () => api.getRun(id) });

export const runEventsQuery = (api: ApiClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.runEvents(id),
    queryFn: async () => (await api.runEvents(id)).items,
  });

export const llmSettingsQuery = (api: ApiClient) =>
  queryOptions({ queryKey: queryKeys.llmSettings, queryFn: () => api.llmSettings() });

/** Query client with defaults suited to this API. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retry network and server errors, never 4xx: those will not change.
        retry: (failures, error) =>
          failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  });
}
