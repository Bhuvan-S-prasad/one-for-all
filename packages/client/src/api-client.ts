import {
  agentListResponseSchema,
  agentSchema,
  errorResponseSchema,
  healthResponseSchema,
  llmSettingsSchema,
  messagePageSchema,
  runEventListSchema,
  runPageSchema,
  runSchema,
  sendMessageResponseSchema,
  sessionResponseSchema,
  setupStatusSchema,
  threadSchema,
  type Agent,
  type AgentListResponse,
  type CreateAgentInput,
  type FirstRunSetupRequest,
  type HealthResponse,
  type LlmSettings,
  type LoginRequest,
  type MessagePage,
  type Run,
  type RunEventList,
  type RunPage,
  type RunStatus,
  type SendMessageResponse,
  type SessionResponse,
  type SetupStatus,
  type Thread,
  type UpdateAgentRequest,
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

/** `?a=1&b=2` from defined values only. */
function query(params: Record<string, string | number | undefined>): string {
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
    /** The person's direct thread with an agent, created on first use. */
    agentThread: (id: string): Promise<Thread> =>
      request("GET", `/api/agents/${encodeURIComponent(id)}/thread`, threadSchema),

    // ── Threads ────────────────────────────────────────────────────────────
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

    // ── Settings ───────────────────────────────────────────────────────────
    llmSettings: (): Promise<LlmSettings> => request("GET", "/api/settings/llm", llmSettingsSchema),
    saveLlmKey: (apiKey: string): Promise<LlmSettings> =>
      request("PUT", "/api/settings/llm/key", llmSettingsSchema, { apiKey }),
    deleteLlmKey: (): Promise<LlmSettings> =>
      request("DELETE", "/api/settings/llm/key", llmSettingsSchema),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
