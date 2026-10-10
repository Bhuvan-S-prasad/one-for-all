import type {
  AddMcpServerInput,
  Agent,
  CreateAgentInput,
  CreatePolicyRuleInput,
  CreateRoutineRequest,
  CreateSkillRequest,
  CreateThreadRequest,
  FirstRunSetupRequest,
  LoginRequest,
  Message,
  OwnClientInput,
  Run,
  SaveLoginRequest,
  SendMessageResponse,
  Thread,
  UpdateAgentRequest,
  UpdateRoutineRequest,
  UpdateSkillRequest,
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
  mcpCatalogQuery,
  mcpServersQuery,
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

/** The person's group chats with several agents (M5.04). */
export function useGroupThreads(options: { archived?: boolean } = {}) {
  const api = useApiClient();
  const archived = options.archived ?? false;
  return useQuery({
    queryKey: queryKeys.groupThreads(archived),
    queryFn: async () => (await api.groupThreads({ archived })).items,
  });
}

/** Start a chat: with one agent a new direct chat, with two to six a group chat. */
export function useCreateThread() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateThreadRequest) => api.createThread(input),
    onSuccess: (thread) => {
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

// ── Routines (M5.06) and things set for later (M5.07) ────────────────────────

export function useRoutines(agentId?: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.routines(agentId),
    queryFn: async () => (await api.listRoutines({ agentId })).items,
  });
}

export function useCreateRoutine() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoutineRequest) => api.createRoutine(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.routineLists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.threadLists });
    },
  });
}

/** Rename, reschedule, pause or resume. */
export function useUpdateRoutine() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateRoutineRequest }) =>
      api.updateRoutine(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.routineLists }),
  });
}

export function useDeleteRoutine() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRoutine(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.routineLists }),
  });
}

/** A test run now; it shows in the routine's history and its chat. */
export function useRunRoutine() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.runRoutine(id),
    onSuccess: (run, id) => {
      queryClient.setQueryData(queryKeys.run(run.id), run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.routineRuns(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runLists });
    },
  });
}

/** A routine's latest runs, newest first. */
export function useRoutineRuns(id: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.routineRuns(id ?? ""),
    queryFn: async () => (await api.routineRuns(id!)).items,
    enabled: !!id,
  });
}

/** What agents set for later and is still waiting, soonest first. */
export function useSchedules(agentId?: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.schedules(agentId),
    queryFn: async () => (await api.listSchedules({ agentId, status: "pending" })).items,
  });
}

export function useCancelSchedule() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelSchedule(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.scheduleLists }),
  });
}

export function useWorkspaceSettings() {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.workspaceSettings,
    queryFn: () => api.workspaceSettings(),
  });
}

export function useSetTimeZone() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (timeZone: string) => api.setTimeZone(timeZone),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.workspaceSettings, settings),
  });
}

// ── Skills (M5.08) and episodes (M5.09) ──────────────────────────────────────

/** All skills, or one agent's with the shared ones (for `/` in its chat). */
export function useSkills(agentId?: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.skills(agentId),
    queryFn: async () => (await api.listSkills({ agentId })).items,
    staleTime: 30_000,
  });
}

export function useCreateSkill() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillRequest) => api.createSkill(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.skillLists }),
  });
}

/** Edit, approve or retire a skill. */
export function useUpdateSkill() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSkillRequest }) =>
      api.updateSkill(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.skillLists }),
  });
}

export function useDeleteSkill() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.skillLists }),
  });
}

export function useEpisodes(agentId?: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.episodes(agentId),
    queryFn: async () => (await api.listEpisodes({ agentId })).items,
  });
}

// ── Approvals ────────────────────────────────────────────────────────────────

/** Requests waiting for a person, for one agent or all. Kept fresh by run events. */
export function useApprovals(agentId?: string) {
  return useQuery(approvalsQuery(useApiClient(), agentId));
}

export function useDecideApproval() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      decision,
      scope,
      edits,
    }: {
      id: string;
      decision: "approve" | "reject";
      scope?: "once" | "site";
      edits?: Record<string, string>;
    }) => api.decideApproval(id, decision, scope, edits),
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

// ── Connections (M4.03, M4.04) ───────────────────────────────────────────────

export function useMcpServers() {
  return useQuery(mcpServersQuery(useApiClient()));
}

export function useMcpCatalog() {
  return useQuery(mcpCatalogQuery(useApiClient()));
}

/** Changes to servers and connections refresh both lists. */
function useConnectionsMutation<I, O>(fn: (input: I) => Promise<O>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useInstallCatalogEntry() {
  const api = useApiClient();
  return useConnectionsMutation(({ entry, client }: { entry: string; client?: OwnClientInput }) =>
    api.installCatalogEntry(entry, client),
  );
}

export function useSetMcpClient() {
  const api = useApiClient();
  return useConnectionsMutation(({ id, client }: { id: string; client: OwnClientInput }) =>
    api.setMcpClient(id, client),
  );
}

/** Starts signing in; the caller sends the browser to the address it returns. */
export function useConnectMcpServer() {
  const api = useApiClient();
  return useConnectionsMutation((id: string) => api.connectMcpServer(id));
}

export function useDisconnectMcpServer() {
  const api = useApiClient();
  return useConnectionsMutation((id: string) => api.disconnectMcpServer(id));
}

export function useRemoveMcpServer() {
  const api = useApiClient();
  return useConnectionsMutation((id: string) => api.removeMcpServer(id));
}

export function useAddMcpServer() {
  const api = useApiClient();
  return useConnectionsMutation((input: AddMcpServerInput) => api.addMcpServer(input));
}

export function useRefreshMcpTools() {
  const api = useApiClient();
  return useConnectionsMutation((id: string) => api.refreshMcpTools(id));
}

/** A connected app's tools as agents see them; off until `serverId` is set. */
export function useAppTools(serverId: string | null) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.appTools(serverId ?? ""),
    queryFn: async () => (await api.appTools(serverId!)).items,
    enabled: !!serverId,
    staleTime: 60_000,
  });
}

export function usePolicyRules() {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.policyRules,
    queryFn: async () => (await api.listPolicyRules()).items,
  });
}

function usePolicyRulesMutation<I, O>(fn: (input: I) => Promise<O>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.policyRules }),
  });
}

export function useCreatePolicyRule() {
  const api = useApiClient();
  return usePolicyRulesMutation((input: CreatePolicyRuleInput) => api.createPolicyRule(input));
}

export function useSetPolicyRuleEnabled() {
  const api = useApiClient();
  return usePolicyRulesMutation(({ id, enabled }: { id: string; enabled: boolean }) =>
    api.setPolicyRuleEnabled(id, enabled),
  );
}

export function useDeletePolicyRule() {
  const api = useApiClient();
  return usePolicyRulesMutation((id: string) => api.deletePolicyRule(id));
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
