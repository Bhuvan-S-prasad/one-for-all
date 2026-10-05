import type {
  Agent,
  CreateAgentInput,
  FirstRunSetupRequest,
  LoginRequest,
  Message,
  Run,
  SaveLoginRequest,
  SendMessageResponse,
  Thread,
  UpdateAgentRequest,
  UpdateThreadRequest,
} from "@ofa/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ApiClient, MemoryFilter, RunFilter } from "./api-client";
import {
  agentQuery,
  agentsQuery,
  agentStatsQuery,
  agentThreadQuery,
  agentThreadsQuery,
  approvalsQuery,
  healthQuery,
  llmSettingsQuery,
  loginsQuery,
  memoriesQuery,
  messagesQuery,
  queryKeys,
  runArtifactsQuery,
  runEventsQuery,
  runQuery,
  runSearchQuery,
  runsQuery,
  sessionQuery,
  setupStatusQuery,
  threadQuery,
  usageQuery,
} from "./query";
import { connectRealtime } from "./realtime";

const ApiClientContext = createContext<ApiClient | null>(null);

/** Makes the API client available to the hooks below. */
export function ApiClientProvider(props: { client: ApiClient; children: ReactNode }) {
  return <ApiClientContext value={props.client}>{props.children}</ApiClientContext>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error("useApiClient must be used inside <ApiClientProvider>");
  return client;
}

/** The signed-in session (`null` when signed out). */
export function useSession() {
  return useQuery(sessionQuery(useApiClient()));
}

export function useSetupStatus() {
  return useQuery(setupStatusQuery(useApiClient()));
}

export function useHealth() {
  return useQuery(healthQuery(useApiClient()));
}

export function useLogin() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginRequest) => api.login(input),
    onSuccess: (session) => queryClient.setQueryData(queryKeys.session, session),
  });
}

export function useFirstRunSetup() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FirstRunSetupRequest) => api.setup(input),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.setupStatus, { needsSetup: false });
      queryClient.setQueryData(queryKeys.session, session);
    },
  });
}

export function useLogout() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      // Drop everything cached for the old session, then mark signed out.
      queryClient.clear();
      queryClient.setQueryData(queryKeys.session, null);
    },
  });
}

// ── Live updates ─────────────────────────────────────────────────────────────

/**
 * Keep the cache in sync with the server over `/api/ws` while signed in.
 * Mount once, in the signed-in layout. Returns the connection status.
 */
export function useRealtimeSync(url: string | null): "connecting" | "open" | "closed" {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("closed");
  useEffect(() => {
    if (!url) return;
    const connection = connectRealtime({ url, queryClient, onStatus: setStatus });
    return () => connection.close();
  }, [url, queryClient]);
  return status;
}

// ── Agents ───────────────────────────────────────────────────────────────────

export function useAgents() {
  return useQuery(agentsQuery(useApiClient()));
}

export function useAgent(id: string) {
  return useQuery(agentQuery(useApiClient(), id));
}

function rememberAgent(queryClient: ReturnType<typeof useQueryClient>, agent: Agent) {
  queryClient.setQueryData(queryKeys.agent(agent.id), agent);
  queryClient.setQueryData<Agent[]>(queryKeys.agents, (list) =>
    list
      ? [...list.filter((a) => a.id !== agent.id), agent].filter((a) => a.status !== "archived")
      : list,
  );
}

/** Hatch an agent. */
export function useCreateAgent() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) => api.createAgent(input),
    onSuccess: (agent) => rememberAgent(queryClient, agent),
  });
}

export function useUpdateAgent(id: string) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateAgentRequest) => api.updateAgent(id, patch),
    onSuccess: (agent) => rememberAgent(queryClient, agent),
  });
}

// ── Chat ─────────────────────────────────────────────────────────────────────

/** The person's current chat with an agent. */
export function useAgentThread(agentId: string) {
  return useQuery(agentThreadQuery(useApiClient(), agentId));
}

/** A chat by ID when one is picked from the history, else the current chat (UX.13). */
export function useChatThread(agentId: string, threadId: string | undefined) {
  const api = useApiClient();
  const current = useQuery({ ...agentThreadQuery(api, agentId), enabled: !threadId });
  const picked = useQuery({ ...threadQuery(api, threadId ?? ""), enabled: !!threadId });
  return threadId ? picked : current;
}

/** An agent's chats, most recent first, optionally matching `q`. */
export function useAgentThreads(agentId: string, q?: string) {
  return useInfiniteQuery(agentThreadsQuery(useApiClient(), agentId, q || undefined));
}

/** Start a new chat; it becomes the agent's current chat. */
export function useNewThread(agentId: string) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.newThread(agentId),
    onSuccess: (thread) => {
      queryClient.setQueryData(queryKeys.agentThread(agentId), thread);
      queryClient.setQueryData(queryKeys.thread(thread.id), thread);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threadLists });
    },
  });
}

/** Rename, archive or bring back a chat. */
export function useUpdateThread() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateThreadRequest }) =>
      api.updateThread(id, patch),
    onSuccess: (thread: Thread) => {
      queryClient.setQueryData(queryKeys.thread(thread.id), thread);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threadLists });
      // The current chat may have changed (archived, or brought back).
      for (const member of thread.members) {
        if (member.type === "agent") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.agentThread(member.agentId) });
        }
      }
    },
  });
}

/** Put a sent message and the run it started into the cache. */
function rememberTurn(
  queryClient: ReturnType<typeof useQueryClient>,
  { message, run }: SendMessageResponse,
) {
  queryClient.setQueryData<Message[]>(queryKeys.messages(message.threadId), (list) =>
    list && !list.some((m) => m.id === message.id) ? [...list, message] : list,
  );
  if (run) {
    queryClient.setQueryData(queryKeys.run(run.id), run);
    void queryClient.invalidateQueries({ queryKey: queryKeys.runLists });
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.threadLists });
}

/**
 * Ask an agent from anywhere (Home, UX.11): the message goes to its current
 * chat, which then opens with the run already going.
 */
export function useAskAgent() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentId, content }: { agentId: string; content: string }) => {
      const thread = await queryClient.fetchQuery(agentThreadQuery(api, agentId));
      return api.sendMessage(thread.id, content);
    },
    onSuccess: (turn) => rememberTurn(queryClient, turn),
  });
}

export function useThreadMessages(threadId: string | undefined) {
  const api = useApiClient();
  return useQuery({ ...messagesQuery(api, threadId ?? ""), enabled: !!threadId });
}

export function useSendMessage(threadId: string | undefined) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => {
      if (!threadId) throw new Error("No thread yet");
      return api.sendMessage(threadId, content);
    },
    onSuccess: (turn) => rememberTurn(queryClient, turn),
  });
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export function useRuns(agentId?: string) {
  return useQuery(runsQuery(useApiClient(), agentId));
}

/** Activity: runs matching filters, newest first, loaded a page at a time. */
export function useRunSearch(filter: RunFilter, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    ...runSearchQuery(useApiClient(), filter),
    enabled: options.enabled ?? true,
  });
}

/** A run and its event log, live while it is open. */
export function useRun(id: string | undefined) {
  const api = useApiClient();
  const run = useQuery({ ...runQuery(api, id ?? ""), enabled: !!id });
  const events = useQuery({ ...runEventsQuery(api, id ?? ""), enabled: !!id });
  return { run, events };
}

export function useStopRun() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.stopRun(id),
    onSuccess: (run: Run) => queryClient.setQueryData(queryKeys.run(run.id), run),
  });
}

/** Ask again: the run's message, in its chat, as a new run. */
export function useRetryRun() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.retryRun(id),
    onSuccess: (turn) => rememberTurn(queryClient, turn),
  });
}

/** What a run produced (M3.06); fetched only when asked for. */
export function useRunArtifacts(runId: string | undefined, options: { enabled?: boolean } = {}) {
  const api = useApiClient();
  return useQuery({
    ...runArtifactsQuery(api, runId ?? ""),
    enabled: !!runId && (options.enabled ?? true),
  });
}

/** Per agent: runs this week and the last good result (UX.12). */
export function useAgentStats() {
  return useQuery(agentStatsQuery(useApiClient()));
}

// ── Memory (UX.14) ───────────────────────────────────────────────────────────

export function useMemories(filter: MemoryFilter, options: { enabled?: boolean } = {}) {
  return useQuery({ ...memoriesQuery(useApiClient(), filter), enabled: options.enabled ?? true });
}

export function useConfirmMemory() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.confirmMemory(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.memoryLists }),
  });
}

export function useForgetMemory() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.forgetMemory(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.memoryLists }),
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────

// ── Approvals ────────────────────────────────────────────────────────────────

/** Requests waiting for a person, for one agent or all. Kept fresh by run events. */
export function useApprovals(agentId?: string) {
  return useQuery(approvalsQuery(useApiClient(), agentId));
}

export function useDecideApproval() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      api.decideApproval(id, decision),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.approvalLists }),
  });
}

// ── Saved logins and the computer (M3.08, M3.10) ─────────────────────────────

export function useSavedLogins() {
  return useQuery(loginsQuery(useApiClient()));
}

export function useSaveLogin() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveLoginRequest) => api.saveLogin(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.logins }),
  });
}

export function useDeleteLogin() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (site: string) => api.deleteLogin(site),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.logins }),
  });
}

export function useShareLogin(agentId: string) {
  const api = useApiClient();
  return useMutation({
    mutationFn: ({ to, site }: { to: string; site: string }) => api.shareLogin(agentId, to, site),
  });
}

/** Model requests today against the daily free quota (UX.11). */
export function useUsageToday() {
  return useQuery(usageQuery(useApiClient()));
}

export function useLlmSettings() {
  return useQuery(llmSettingsQuery(useApiClient()));
}

export function useSaveLlmKey() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) => api.saveLlmKey(apiKey),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.llmSettings, settings),
  });
}

export function useDeleteLlmKey() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteLlmKey(),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.llmSettings, settings),
  });
}
