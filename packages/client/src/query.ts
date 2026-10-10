import { infiniteQueryOptions, QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, type ApiClient, type MemoryFilter, type RunFilter } from "./api-client";

export const queryKeys = {
  session: ["session"] as const,
  setupStatus: ["setup-status"] as const,
  health: ["health"] as const,
  agents: ["agents"] as const,
  agent: (id: string) => ["agents", id] as const,
  agentThread: (id: string) => ["agents", id, "thread"] as const,
  agentThreads: (id: string, q?: string) => ["threads", "list", id, q ?? ""] as const,
  threadLists: ["threads", "list"] as const,
  groupThreads: (archived: boolean) => ["threads", "list", "groups", archived] as const,
  thread: (id: string) => ["threads", id] as const,
  agentStats: ["agents-stats"] as const,
  memories: (filter: MemoryFilter) => ["memories", filter] as const,
  memoryLists: ["memories"] as const,
  usage: ["settings", "usage"] as const,
  logins: ["settings", "logins"] as const,
  messages: (threadId: string) => ["threads", threadId, "messages"] as const,
  runs: (agentId?: string) => ["runs", "list", agentId ?? "all"] as const,
  runLists: ["runs", "list"] as const,
  runSearch: (filter: RunFilter) => ["runs", "search", filter] as const,
  runSearches: ["runs", "search"] as const,
  run: (id: string) => ["runs", id] as const,
  runEvents: (id: string) => ["runs", id, "events"] as const,
  runArtifacts: (id: string) => ["runs", id, "artifacts"] as const,
  approvals: (agentId?: string) => ["approvals", agentId ?? "all"] as const,
  approvalLists: ["approvals"] as const,
  llmSettings: ["settings", "llm"] as const,
  mcpServers: ["connections", "servers"] as const,
  mcpCatalog: ["connections", "catalog"] as const,
  connections: ["connections"] as const,
  appTools: (serverId: string) => ["connections", "tools", serverId] as const,
  policyRules: ["policy-rules"] as const,
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

/** An agent's chats, a page at a time (UX.13). */
export const agentThreadsQuery = (api: ApiClient, agentId: string, q?: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.agentThreads(agentId, q),
    queryFn: ({ pageParam }) =>
      api.agentThreads(agentId, { q, limit: 30, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

export const threadQuery = (api: ApiClient, id: string) =>
  queryOptions({ queryKey: queryKeys.thread(id), queryFn: () => api.getThread(id) });

export const agentStatsQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: queryKeys.agentStats,
    queryFn: async () => (await api.agentStats()).items,
  });

export const memoriesQuery = (api: ApiClient, filter: MemoryFilter) =>
  queryOptions({
    queryKey: queryKeys.memories(filter),
    queryFn: async () => (await api.listMemories(filter)).items,
  });

/** Today's model requests; refreshed each minute while shown (UX.11). */
export const usageQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: queryKeys.usage,
    queryFn: () => api.usageToday(),
    refetchInterval: 60_000,
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

/** Activity: filtered runs, a page at a time (UX.10). */
export const runSearchQuery = (api: ApiClient, filter: RunFilter) =>
  infiniteQueryOptions({
    queryKey: queryKeys.runSearch(filter),
    queryFn: ({ pageParam }) =>
      api.listRuns({ ...filter, limit: 40, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

export const runQuery = (api: ApiClient, id: string) =>
  queryOptions({ queryKey: queryKeys.run(id), queryFn: () => api.getRun(id) });

export const runEventsQuery = (api: ApiClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.runEvents(id),
    queryFn: async () => (await api.runEvents(id)).items,
  });

export const runArtifactsQuery = (api: ApiClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.runArtifacts(id),
    queryFn: async () => (await api.runArtifacts(id)).items,
    staleTime: Infinity,
  });

export const approvalsQuery = (api: ApiClient, agentId?: string) =>
  queryOptions({
    queryKey: queryKeys.approvals(agentId),
    queryFn: async () => (await api.listApprovals(agentId ? { agentId } : {})).items,
  });

export const loginsQuery = (api: ApiClient) =>
  queryOptions({ queryKey: queryKeys.logins, queryFn: async () => (await api.listLogins()).items });

export const mcpServersQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: queryKeys.mcpServers,
    queryFn: async () => (await api.listMcpServers()).items,
  });

export const mcpCatalogQuery = (api: ApiClient) =>
  queryOptions({ queryKey: queryKeys.mcpCatalog, queryFn: () => api.mcpCatalog() });

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
