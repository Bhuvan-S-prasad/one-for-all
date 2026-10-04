import type {
  Agent,
  CreateAgentInput,
  FirstRunSetupRequest,
  LoginRequest,
  Message,
  Run,
  UpdateAgentRequest,
} from "@ofa/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ApiClient, RunFilter } from "./api-client";
import {
  agentQuery,
  agentsQuery,
  agentThreadQuery,
  healthQuery,
  llmSettingsQuery,
  messagesQuery,
  queryKeys,
  runEventsQuery,
  runQuery,
  runSearchQuery,
  runsQuery,
  sessionQuery,
  setupStatusQuery,
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

/** The person's direct thread with an agent and its messages. */
export function useAgentThread(agentId: string) {
  return useQuery(agentThreadQuery(useApiClient(), agentId));
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
    onSuccess: ({ message, run }) => {
      queryClient.setQueryData<Message[]>(queryKeys.messages(message.threadId), (list) =>
        list && !list.some((m) => m.id === message.id) ? [...list, message] : list,
      );
      if (run) {
        queryClient.setQueryData(queryKeys.run(run.id), run);
        void queryClient.invalidateQueries({ queryKey: queryKeys.runLists });
      }
    },
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

// ── Settings ─────────────────────────────────────────────────────────────────

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
