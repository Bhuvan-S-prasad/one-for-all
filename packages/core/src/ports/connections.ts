import { AppError } from "../errors";
import type { TenantContext } from "../tenant";

// Connections to apps through their MCP servers (ARCHITECTURE.md §9,
// ADR-0011). A workspace installs a server (a catalog entry or a custom one);
// each person signs in to it once. Tokens and OAuth client secrets are kept
// sealed by the vault and opened only by the MCP client (hard rule 4).

/** A vault envelope, as stored: never the plaintext. */
export interface SealedValue {
  readonly valueCiphertext: string;
  readonly keyCiphertext: string;
  readonly keyId: string;
}

/** Seals a record's value, bound to its table and row (the vault). */
export interface RecordCipher {
  seal(
    ctx: TenantContext,
    scope: { readonly table: "connection" | "mcp_server"; readonly id: string },
    value: string,
  ): SealedValue;
  open(
    ctx: TenantContext,
    scope: { readonly table: "connection" | "mcp_server"; readonly id: string },
    sealed: SealedValue,
  ): string;
}

export const MCP_AUTH_KINDS = ["oauth", "none"] as const;
export type McpAuthKind = (typeof MCP_AUTH_KINDS)[number];

export interface McpServerRecord {
  readonly id: string;
  /** The app part of its tool names (`notion` in `notion.search`). */
  readonly slug: string;
  readonly name: string;
  /** The catalog entry it came from; null for a custom server. */
  readonly catalogId: string | null;
  readonly url: string;
  readonly auth: McpAuthKind;
  /** Where sign-in must happen; pinned by the catalog or at the first sign-in. */
  readonly authOrigin: string | null;
  /** The OAuth client registration, sealed. */
  readonly client: SealedValue | null;
  readonly enabled: boolean;
  /** The server's tools as `tools/list` last returned them (M4.05). */
  readonly tools: readonly McpToolInfo[] | null;
  readonly toolsFetchedAt: Date | null;
  readonly createdAt: Date;
}

/** A tool as an MCP server describes it. */
export interface McpToolInfo {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export const CONNECTION_STATUSES = ["pending", "active", "needs_reauth"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface ConnectionRecord {
  readonly id: string;
  readonly mcpServerId: string;
  readonly userId: string;
  readonly status: ConnectionStatus;
  readonly account: string | null;
  readonly scopes: readonly string[];
  /** Tokens, or the PKCE verifier while signing in, sealed. */
  readonly credentials: SealedValue | null;
  readonly oauthState: string | null;
  readonly expiresAt: Date | null;
  readonly refreshedAt: Date | null;
  readonly lastUsedAt: Date | null;
  /** Why it needs signing in again, in plain words. */
  readonly lastError: string | null;
  readonly updatedAt: Date;
}

export interface McpServerInput {
  readonly slug: string;
  readonly name: string;
  readonly url: string;
  readonly catalogId?: string | null;
  readonly auth?: McpAuthKind;
  readonly authOrigin?: string | null;
}

/** Fields of a connection to change; `undefined` leaves a field as it is. */
export interface ConnectionPatch {
  readonly status?: ConnectionStatus;
  readonly account?: string | null;
  readonly scopes?: readonly string[];
  readonly credentials?: SealedValue | null;
  readonly oauthState?: string | null;
  readonly expiresAt?: Date | null;
  readonly refreshedAt?: Date | null;
  readonly lastUsedAt?: Date | null;
  readonly lastError?: string | null;
}

/**
 * Servers and connections in the database. Connection methods act for
 * `ctx.userId`: a person signs in, and a run acts with the sign-in of the
 * person it works for.
 */
export interface ConnectionStore {
  getServer(ctx: TenantContext, id: string): Promise<McpServerRecord | null>;
  listServers(ctx: TenantContext): Promise<McpServerRecord[]>;
  /** Null when the slug or catalog entry is already installed. */
  createServer(ctx: TenantContext, input: McpServerInput): Promise<McpServerRecord | null>;
  deleteServer(ctx: TenantContext, id: string): Promise<boolean>;
  saveServerClient(ctx: TenantContext, id: string, client: SealedValue | null): Promise<void>;
  /** Keep the server's tool list, as one person's sign-in saw it. */
  saveServerTools(ctx: TenantContext, id: string, tools: readonly McpToolInfo[]): Promise<void>;
  /** Pin where sign-in happens, if nothing is pinned yet; returns the pinned origin. */
  pinAuthOrigin(ctx: TenantContext, id: string, origin: string): Promise<string>;

  getConnection(ctx: TenantContext, serverId: string): Promise<ConnectionRecord | null>;
  /** The connection waiting for this sign-in to come back. */
  findConnectionByState(ctx: TenantContext, state: string): Promise<ConnectionRecord | null>;
  listConnections(ctx: TenantContext): Promise<ConnectionRecord[]>;
  /** Create the person's connection to a server if needed, then apply the patch. */
  saveConnection(
    ctx: TenantContext,
    serverId: string,
    patch: ConnectionPatch,
  ): Promise<ConnectionRecord>;
  deleteConnection(ctx: TenantContext, serverId: string): Promise<boolean>;
}

/** Why an MCP server could not be used, for the person and the agent. */
export const MCP_ERROR_REASONS = [
  /** No sign-in yet, or it expired and could not be refreshed. */
  "sign_in_required",
  /** The server sent sign-in somewhere other than where it was set up to. */
  "auth_origin_mismatch",
  /** The sign-in that came back doesn't match one in progress. */
  "sign_in_unknown",
  /** The server could not be reached or answered with something unusable. */
  "unavailable",
] as const;
export type McpErrorReason = (typeof MCP_ERROR_REASONS)[number];

export class McpError extends AppError {
  readonly reason: McpErrorReason;

  constructor(reason: McpErrorReason, message: string) {
    super(reason === "unavailable" ? "internal" : "bad_request", message);
    this.name = "McpError";
    this.reason = reason;
  }
}
