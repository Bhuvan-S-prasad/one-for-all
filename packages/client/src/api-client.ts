import {
  routineListSchema,
  routineRunsSchema,
  routineSchema,
  scheduleListSchema,
  scheduleSchema,
  workspaceSettingsSchema,
  type CreateRoutineRequest,
  type Routine,
  type RoutineList,
  type RoutineRuns,
  type Schedule,
  type ScheduleList,
  type UpdateRoutineRequest,
  type WorkspaceSettings,
  agentListResponseSchema,
  agentSchema,
  agentStatsListSchema,
  approvalListSchema,
  approvalSchema,
  appToolListSchema,
  artifactListSchema,
  catalogListSchema,
  mcpServerListSchema,
  mcpServerSchema,
  mcpToolListSchema,
  policyRuleListSchema,
  policyRuleSchema,
  signInStartSchema,
  toolRefreshSchema,
  errorResponseSchema,
  healthResponseSchema,
  llmSettingsSchema,
  memoryItemSchema,
  memoryListSchema,
  messagePageSchema,
  runEventListSchema,
  runPageSchema,
  runSchema,
  savedLoginListSchema,
  savedLoginSchema,
  sendMessageResponseSchema,
  shareLoginResponseSchema,
  sessionResponseSchema,
  setupStatusSchema,
  threadListSchema,
  threadSchema,
  threadSummaryPageSchema,
  usageTodaySchema,
  type Agent,
  type AgentListResponse,
  type AgentStatsList,
  type Approval,
  type ApprovalList,
  type ArtifactList,
  type CatalogList,
  type McpServer,
  type McpServerList,
  type McpToolList,
  type AddMcpServerInput,
  type AppToolList,
  type CreatePolicyRuleInput,
  type PolicyRuleItem,
  type PolicyRuleList,
  type ToolRefreshResponse,
  type OwnClientInput,
  type SignInStartResponse,
  type CreateAgentInput,
  type FirstRunSetupRequest,
  type HealthResponse,
  type LlmSettings,
  type LoginRequest,
  type MemoryItem,
  type MemoryList,
  type MessagePage,
  type Run,
  type RunEventList,
  type RunPage,
  type RunStatus,
  type SavedLogin,
  type SavedLoginList,
  type SaveLoginRequest,
  type ShareLoginResponse,
  type SendMessageResponse,
  type SessionResponse,
  type SetupStatus,
  type CreateThreadRequest,
  type Thread,
  type ThreadList,
  type ThreadSummaryPage,
  type UpdateAgentRequest,
  type UpdateThreadRequest,
  type UsageToday,
} from "@ofa/contracts";
import type { ErrorCode } from "@ofa/core";
import type { z } from "zod";

/** An error response from the API, or a network failure (`status` 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Per-field messages from a `validation_failed` response, keyed by field path. */
  fieldErrors(): Record<string, string> {
    const issues = (this.details as { issues?: { path: string; message: string }[] } | undefined)
      ?.issues;
    return Object.fromEntries((issues ?? []).map((issue) => [issue.path, issue.message]));
  }
}

export interface ApiClientOptions {
  /** API origin. Empty (default) means same origin, as in the web app. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Workspace to act in; sent as `x-workspace-id`. Defaults to the first one. */
  readonly workspaceId?: () => string | undefined;
}

/** Activity filters for `listRuns` (UX.10). */
export interface RunFilter {
  readonly agentId?: string;
  readonly status?: readonly RunStatus[];
  /** Search over what was asked. */
  readonly q?: string;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Memory review filters (UX.14). */
export interface MemoryFilter {
  readonly agentId?: string;
  readonly runId?: string;
  /** `false`: only facts waiting to be confirmed. */
  readonly verified?: boolean;
}

/** `?a=1&b=2` from defined values only. */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * Typed client for the One-for-All API. Every response is validated with the
 * contracts schema, so a server/client mismatch fails loudly here instead of
 * as `undefined` somewhere in the UI.
 *
 * Built from `@ofa/contracts` rather than Hono's RPC types, because those
 * would mean importing from `apps/api` (dependency rule R1).
 */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>>;
  async function request(method: Method, path: string, schema: null, body?: unknown): Promise<void>;
  async function request(
    method: Method,
    path: string,
    schema: z.ZodType | null,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const workspaceId = options.workspaceId?.();
    if (workspaceId) headers["x-workspace-id"] = workspaceId;

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "internal", "Cannot reach the server. Is it running?");
    }

    if (!res.ok) {
      const parsed = errorResponseSchema.safeParse(await res.json().catch(() => null));
      if (parsed.success) {
        const { code, message, details } = parsed.data.error;
        throw new ApiError(res.status, code, message, details);
      }
      throw new ApiError(res.status, "internal", `Unexpected response (${res.status})`);
    }
    if (schema === null || res.status === 204) return undefined;
    return schema.parse(await res.json());
  }

  return {
    health: (): Promise<HealthResponse> => request("GET", "/api/health", healthResponseSchema),

    setupStatus: (): Promise<SetupStatus> => request("GET", "/api/setup", setupStatusSchema),

    setup: (input: FirstRunSetupRequest): Promise<SessionResponse> =>
      request("POST", "/api/setup", sessionResponseSchema, input),

    login: (input: LoginRequest): Promise<SessionResponse> =>
      request("POST", "/api/session", sessionResponseSchema, input),

    /** The current session, or null when signed out. */
    session: async (): Promise<SessionResponse | null> => {
      try {
        return await request("GET", "/api/session", sessionResponseSchema);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },

    logout: (): Promise<void> => request("DELETE", "/api/session", null),

    // ── Agents ─────────────────────────────────────────────────────────────
    listAgents: (): Promise<AgentListResponse> =>
      request("GET", "/api/agents", agentListResponseSchema),
    getAgent: (id: string): Promise<Agent> =>
      request("GET", `/api/agents/${encodeURIComponent(id)}`, agentSchema),
    createAgent: (input: CreateAgentInput): Promise<Agent> =>
      request("POST", "/api/agents", agentSchema, input),
    updateAgent: (id: string, patch: UpdateAgentRequest): Promise<Agent> =>
      request("PATCH", `/api/agents/${encodeURIComponent(id)}`, agentSchema, patch),
    /** The person's current chat with an agent, created on first use. */
    agentThread: (id: string): Promise<Thread> =>
      request("GET", `/api/agents/${encodeURIComponent(id)}/thread`, threadSchema),
    /** The person's chats with an agent, most recent first (UX.13). */
    agentThreads: (
      id: string,
      page: { q?: string; limit?: number; cursor?: string } = {},
    ): Promise<ThreadSummaryPage> =>
      request(
        "GET",
        `/api/agents/${encodeURIComponent(id)}/threads${query(page)}`,
        threadSummaryPageSchema,
      ),
    /** Start a new chat with an agent (an empty current chat is reused). */
    newThread: (id: string): Promise<Thread> =>
      request("POST", `/api/agents/${encodeURIComponent(id)}/threads`, threadSchema),
    /** Copy one site's browser login from an agent to another (ADR-0010). */
    shareLogin: (agentId: string, to: string, site: string): Promise<ShareLoginResponse> =>
      request(
        "POST",
        `/api/agents/${encodeURIComponent(agentId)}/logins/share`,
        shareLoginResponseSchema,
        { to, site },
      ),
    agentStats: (): Promise<AgentStatsList> =>
      request("GET", "/api/agents/stats", agentStatsListSchema),

    // ── Threads ────────────────────────────────────────────────────────────
    /** The person's group chats, most recent first (M5.04). */
    groupThreads: (options: { archived?: boolean } = {}): Promise<ThreadList> =>
      request("GET", `/api/threads${options.archived ? "?archived=true" : ""}`, threadListSchema),
    /** A group chat with two to six agents (one agent makes a direct chat). */
    createThread: (input: CreateThreadRequest): Promise<Thread> =>
      request("POST", "/api/threads", threadSchema, input),
    getThread: (id: string): Promise<Thread> =>
      request("GET", `/api/threads/${encodeURIComponent(id)}`, threadSchema),
    updateThread: (id: string, patch: UpdateThreadRequest): Promise<Thread> =>
      request("PATCH", `/api/threads/${encodeURIComponent(id)}`, threadSchema, patch),
    listMessages: (
      threadId: string,
      page: { limit?: number; cursor?: string } = {},
    ): Promise<MessagePage> =>
      request(
        "GET",
        `/api/threads/${encodeURIComponent(threadId)}/messages${query(page)}`,
        messagePageSchema,
      ),
    sendMessage: (threadId: string, content: string): Promise<SendMessageResponse> =>
      request(
        "POST",
        `/api/threads/${encodeURIComponent(threadId)}/messages`,
        sendMessageResponseSchema,
        {
          content,
        },
      ),

    // ── Runs ───────────────────────────────────────────────────────────────
    listRuns: (filter: RunFilter & { limit?: number; cursor?: string } = {}): Promise<RunPage> =>
      request(
        "GET",
        `/api/runs${query({ ...filter, status: filter.status?.length ? filter.status.join(",") : undefined })}`,
        runPageSchema,
      ),
    getRun: (id: string): Promise<Run> =>
      request("GET", `/api/runs/${encodeURIComponent(id)}`, runSchema),
    runEvents: (id: string, after?: number): Promise<RunEventList> =>
      request(
        "GET",
        `/api/runs/${encodeURIComponent(id)}/events${query({ after })}`,
        runEventListSchema,
      ),
    stopRun: (id: string): Promise<Run> =>
      request("POST", `/api/runs/${encodeURIComponent(id)}/stop`, runSchema),
    /** Files and long output a run produced (M3.06). */
    runArtifacts: (id: string): Promise<ArtifactList> =>
      request("GET", `/api/runs/${encodeURIComponent(id)}/artifacts`, artifactListSchema),
    /** Where an artifact's content downloads from (same origin, with the session cookie). */
    artifactContentUrl: (id: string): string =>
      `${baseUrl}/api/artifacts/${encodeURIComponent(id)}/content`,
    /** Ask again: the run's message, in the same chat, as a new run (UX.12). */
    retryRun: (id: string): Promise<SendMessageResponse> =>
      request("POST", `/api/runs/${encodeURIComponent(id)}/retry`, sendMessageResponseSchema),

    // ── Routines (M5.06) and things set for later (M5.07) ─────────────────
    listRoutines: (filter: { agentId?: string } = {}): Promise<RoutineList> =>
      request("GET", `/api/routines${query({ ...filter })}`, routineListSchema),
    createRoutine: (input: CreateRoutineRequest): Promise<Routine> =>
      request("POST", "/api/routines", routineSchema, input),
    updateRoutine: (id: string, patch: UpdateRoutineRequest): Promise<Routine> =>
      request("PATCH", `/api/routines/${encodeURIComponent(id)}`, routineSchema, patch),
    deleteRoutine: (id: string): Promise<void> =>
      request("DELETE", `/api/routines/${encodeURIComponent(id)}`, null),
    /** A test run now, outside the schedule. */
    runRoutine: (id: string): Promise<Run> =>
      request("POST", `/api/routines/${encodeURIComponent(id)}/run`, runSchema),
    routineRuns: (id: string): Promise<RoutineRuns> =>
      request("GET", `/api/routines/${encodeURIComponent(id)}/runs`, routineRunsSchema),
    listSchedules: (
      filter: { agentId?: string; status?: Schedule["status"] } = {},
    ): Promise<ScheduleList> =>
      request("GET", `/api/schedules${query({ ...filter })}`, scheduleListSchema),
    cancelSchedule: (id: string): Promise<Schedule> =>
      request("DELETE", `/api/schedules/${encodeURIComponent(id)}`, scheduleSchema),
    workspaceSettings: (): Promise<WorkspaceSettings> =>
      request("GET", "/api/settings/workspace", workspaceSettingsSchema),
    setTimeZone: (timeZone: string): Promise<WorkspaceSettings> =>
      request("PUT", "/api/settings/workspace", workspaceSettingsSchema, { timeZone }),

    // ── Approvals ──────────────────────────────────────────────────────────
    /** Waiting for an answer, newest first. */
    listApprovals: (filter: { agentId?: string; runId?: string } = {}): Promise<ApprovalList> =>
      request("GET", `/api/approvals${query({ ...filter })}`, approvalListSchema),
    /** `site`: approve every call like it on the approval’s site for the rest of the run. */
    /** `edits`: text the card offered for editing, changed before approving (ADR-0030). */
    decideApproval: (
      id: string,
      decision: "approve" | "reject",
      scope: "once" | "site" = "once",
      edits?: Record<string, string>,
    ): Promise<Approval> =>
      request("POST", `/api/approvals/${encodeURIComponent(id)}`, approvalSchema, {
        decision,
        scope,
        ...(edits && Object.keys(edits).length > 0 ? { edits } : {}),
      }),

    // ── Rules (M4.07, M4.09) ───────────────────────────────────────────────
    /** The workspace's rules and your own. */
    listPolicyRules: (): Promise<PolicyRuleList> =>
      request("GET", "/api/policy-rules", policyRuleListSchema),
    createPolicyRule: (input: CreatePolicyRuleInput): Promise<PolicyRuleItem> =>
      request("POST", "/api/policy-rules", policyRuleSchema, input),
    setPolicyRuleEnabled: (id: string, enabled: boolean): Promise<PolicyRuleItem> =>
      request("PATCH", `/api/policy-rules/${encodeURIComponent(id)}`, policyRuleSchema, {
        enabled,
      }),
    deletePolicyRule: (id: string): Promise<void> =>
      request("DELETE", `/api/policy-rules/${encodeURIComponent(id)}`, null),

    // ── Saved logins (M3.08) ───────────────────────────────────────────────
    listLogins: (): Promise<SavedLoginList> => request("GET", "/api/logins", savedLoginListSchema),
    saveLogin: (input: SaveLoginRequest): Promise<SavedLogin> =>
      request("PUT", "/api/logins", savedLoginSchema, input),
    deleteLogin: (site: string): Promise<void> =>
      request("DELETE", `/api/logins/${encodeURIComponent(site)}`, null),

    // ── Connections: apps through MCP servers (M4.03, M4.04) ───────────────
    listMcpServers: (): Promise<McpServerList> =>
      request("GET", "/api/mcp-servers", mcpServerListSchema),
    mcpCatalog: (): Promise<CatalogList> =>
      request("GET", "/api/mcp-servers/catalog", catalogListSchema),
    /** Add a catalog app; `client` is your own OAuth app, for apps that need one. */
    installCatalogEntry: (entry: string, client?: OwnClientInput): Promise<McpServer> =>
      request(
        "POST",
        `/api/mcp-servers/catalog/${encodeURIComponent(entry)}`,
        mcpServerSchema,
        client ? { client } : {},
      ),
    setMcpClient: (id: string, client: OwnClientInput): Promise<void> =>
      request("PUT", `/api/mcp-servers/${encodeURIComponent(id)}/client`, null, client),
    /** Start signing in: open `authorizationUrl` in this tab. */
    connectMcpServer: (id: string): Promise<SignInStartResponse> =>
      request("POST", `/api/mcp-servers/${encodeURIComponent(id)}/connect`, signInStartSchema),
    disconnectMcpServer: (id: string): Promise<void> =>
      request("DELETE", `/api/mcp-servers/${encodeURIComponent(id)}/connection`, null),
    removeMcpServer: (id: string): Promise<void> =>
      request("DELETE", `/api/mcp-servers/${encodeURIComponent(id)}`, null),
    listMcpTools: (id: string): Promise<McpToolList> =>
      request("GET", `/api/mcp-servers/${encodeURIComponent(id)}/tools`, mcpToolListSchema),
    /** A custom server: not reviewed, so it needs `acknowledgeRisk`. Owners and admins. */
    addMcpServer: (input: AddMcpServerInput): Promise<McpServer> =>
      request("POST", "/api/mcp-servers", mcpServerSchema, input),
    /** Fetch the app's tool list again with your sign-in; agents use the kept one. */
    refreshMcpTools: (id: string): Promise<ToolRefreshResponse> =>
      request(
        "POST",
        `/api/mcp-servers/${encodeURIComponent(id)}/tools/refresh`,
        toolRefreshSchema,
      ),
    /** The app's tools as agents see them (`notion.search`), for choosing what an agent may use. */
    appTools: (id: string): Promise<AppToolList> =>
      request("GET", `/api/mcp-servers/${encodeURIComponent(id)}/agent-tools`, appToolListSchema),

    // ── Memory (UX.14) ─────────────────────────────────────────────────────
    listMemories: (filter: MemoryFilter = {}): Promise<MemoryList> =>
      request("GET", `/api/memories${query({ ...filter })}`, memoryListSchema),
    confirmMemory: (id: string): Promise<MemoryItem> =>
      request("POST", `/api/memories/${encodeURIComponent(id)}/confirm`, memoryItemSchema),
    forgetMemory: (id: string): Promise<void> =>
      request("DELETE", `/api/memories/${encodeURIComponent(id)}`, null),

    // ── Settings ───────────────────────────────────────────────────────────
    llmSettings: (): Promise<LlmSettings> => request("GET", "/api/settings/llm", llmSettingsSchema),
    usageToday: (): Promise<UsageToday> => request("GET", "/api/settings/usage", usageTodaySchema),
    saveLlmKey: (apiKey: string): Promise<LlmSettings> =>
      request("PUT", "/api/settings/llm/key", llmSettingsSchema, { apiKey }),
    deleteLlmKey: (): Promise<LlmSettings> =>
      request("DELETE", "/api/settings/llm/key", llmSettingsSchema),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
