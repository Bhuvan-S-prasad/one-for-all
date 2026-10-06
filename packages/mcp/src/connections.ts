import { auth, createMCPClient, UnauthorizedError, type MCPClient } from "@ai-sdk/mcp";
import {
  AppError,
  McpError,
  NotFoundError,
  type ConnectionStore,
  type JsonSchema,
  type McpServerRecord,
  type RecordCipher,
  type TenantContext,
} from "@ofa/core";
import { CATALOG, type CatalogEntry } from "./catalog";
import { createDbAuthProvider, type DbAuthProvider } from "./provider";

// One generic client for every app with a remote MCP server (ADR-0011): sign
// a person in with OAuth, then list and call the server's tools with their
// tokens. Tokens never leave this module; callers get tool results only.

export interface McpConnectionsOptions {
  readonly store: ConnectionStore;
  readonly cipher: RecordCipher;
  /** The API's OAuth callback, e.g. `http://localhost:3000/api/connections/callback`. */
  readonly redirectUrl: string;
  /** How we introduce ourselves when registering with a server. */
  readonly clientName?: string;
  /** The reviewed catalog; the built-in one unless a test passes its own. */
  readonly catalog?: readonly CatalogEntry[];
  readonly now?: () => number;
}

/** An OAuth app the self-hoster created, for catalog entries with `own_client` setup. */
export interface OwnClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

/** A tool as the server describes it. */
export interface McpToolInfo {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface McpCallResult {
  /** The result as text: text parts joined, other parts described. */
  readonly text: string;
  /** The server said the call failed (the model should see why). */
  readonly isError: boolean;
  readonly structured?: unknown;
}

export interface McpSession {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export type SignInStart =
  | { readonly status: "redirect"; readonly authorizationUrl: string }
  | { readonly status: "connected" };

export interface McpConnections {
  /** Install a catalog entry in the workspace, with the self-hoster's OAuth app if it needs one. */
  install(ctx: TenantContext, entryId: string, client?: OwnClient): Promise<McpServerRecord>;
  /** Replace the OAuth app a server signs in with. */
  setClient(ctx: TenantContext, serverId: string, client: OwnClient): Promise<void>;
  /** Begin signing the person in; they open the returned address. */
  startSignIn(ctx: TenantContext, serverId: string): Promise<SignInStart>;
  /** The provider sent the person back: exchange the code for tokens. */
  finishSignIn(
    ctx: TenantContext,
    params: { readonly state: string; readonly code: string; readonly issuer?: string },
  ): Promise<McpServerRecord>;
  /** A session with the server as the person, for listing and calling tools. */
  connect(ctx: TenantContext, serverId: string): Promise<McpSession>;
  /** Refresh the person's tokens now (background refresh, M4.06). */
  refresh(ctx: TenantContext, serverId: string): Promise<"refreshed" | "sign_in_required">;
  disconnect(ctx: TenantContext, serverId: string): Promise<boolean>;
}

const PAGE_LIMIT = 20;

function textOf(content: readonly Record<string, unknown>[]): string {
  return content
    .map((part) => {
      if (part.type === "text") return String(part.text ?? "");
      if (part.type === "resource") {
        const resource = part.resource as { uri?: string; text?: string } | undefined;
        return resource?.text ?? `[resource ${resource?.uri ?? ""}]`;
      }
      if (part.type === "resource_link") return `[link ${String(part.uri ?? "")}]`;
      return `[${String(part.type)} content]`;
    })
    .join("\n");
}

function unavailable(server: McpServerRecord, error: unknown): McpError {
  const why = error instanceof Error ? error.message : String(error);
  return new McpError("unavailable", `Couldn't use ${server.name}: ${why.slice(0, 300)}`);
}

export function createMcpConnections(options: McpConnectionsOptions): McpConnections {
  const { store, cipher } = options;
  const clientName = options.clientName ?? "One-for-All";
  const catalog = options.catalog ?? CATALOG;
  const entryOf = (server: McpServerRecord) =>
    server.catalogId ? catalog.find((e) => e.id === server.catalogId) : undefined;

  /** Seal a pre-registered client: it was not registered by us, so it is never replaced automatically. */
  async function saveOwnClient(ctx: TenantContext, serverId: string, client: OwnClient) {
    const value = {
      client: {
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      },
      dynamic: false,
    };
    await store.saveServerClient(
      ctx,
      serverId,
      cipher.seal(ctx, { table: "mcp_server", id: serverId }, JSON.stringify(value)),
    );
  }

  async function serverOf(ctx: TenantContext, id: string): Promise<McpServerRecord> {
    const server = await store.getServer(ctx, id);
    if (!server) throw new NotFoundError("Server");
    return server;
  }

  const providerFor = (ctx: TenantContext, server: McpServerRecord): Promise<DbAuthProvider> =>
    createDbAuthProvider({
      ctx,
      server,
      store,
      cipher,
      redirectUrl: options.redirectUrl,
      clientName,
      ...(entryOf(server)?.authorizationParams
        ? { authorizationParams: entryOf(server)!.authorizationParams! }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    });

  /** Our own errors pass through; anything else means the server couldn't be used. */
  const rethrow = (server: McpServerRecord, error: unknown): never => {
    if (error instanceof McpError) throw error;
    throw unavailable(server, error);
  };

  async function signInRequired(ctx: TenantContext, server: McpServerRecord): Promise<McpError> {
    if ((await store.getConnection(ctx, server.id))?.status === "active") {
      await store.saveConnection(ctx, server.id, {
        status: "needs_reauth",
        lastError: "The sign-in expired. Sign in again.",
      });
    }
    return new McpError("sign_in_required", `Sign in to ${server.name} first.`);
  }

  return {
    async install(ctx, entryId, client) {
      const entry = catalog.find((e) => e.id === entryId);
      if (!entry) throw new NotFoundError("Catalog entry");
      if (entry.setup === "own_client" && !client?.clientId) {
        throw new AppError(
          "validation_failed",
          `${entry.name} needs your own OAuth app: enter its client ID (and secret).`,
        );
      }
      const server = await store.createServer(ctx, {
        slug: entry.id,
        name: entry.name,
        url: entry.url,
        catalogId: entry.id,
        authOrigin: entry.authOrigin,
      });
      if (!server) throw new AppError("conflict", `${entry.name} is already added.`);
      if (client?.clientId) await saveOwnClient(ctx, server.id, client);
      return (await store.getServer(ctx, server.id)) ?? server;
    },

    async setClient(ctx, serverId, client) {
      const server = await serverOf(ctx, serverId);
      await saveOwnClient(ctx, server.id, client);
    },

    async startSignIn(ctx, serverId) {
      const server = await serverOf(ctx, serverId);
      if (server.auth === "none") return { status: "connected" };
      const entry = entryOf(server);
      if (entry?.setup === "own_client" && !server.client) {
        throw new McpError(
          "sign_in_required",
          `An admin needs to enter ${entry.name}'s OAuth app first.`,
        );
      }
      const provider = await providerFor(ctx, server);
      try {
        const result = await auth(provider, {
          serverUrl: server.url,
          // Only what the entry asks for, not every scope the server offers.
          ...(entry?.scopes ? { scope: entry.scopes.join(" ") } : {}),
        });
        if (result === "AUTHORIZED") return { status: "connected" };
      } catch (error) {
        rethrow(server, error);
      }
      if (!provider.authorizationUrl) throw unavailable(server, "no sign-in address");
      return { status: "redirect", authorizationUrl: provider.authorizationUrl.href };
    },

    async finishSignIn(ctx, { state, code, issuer }) {
      const pending = await store.findConnectionByState(ctx, state);
      if (!pending) {
        throw new McpError(
          "sign_in_unknown",
          "This sign-in doesn't match one in progress. Start it again from One-for-All.",
        );
      }
      const server = await serverOf(ctx, pending.mcpServerId);
      const provider = await providerFor(ctx, server);
      try {
        await auth(provider, {
          serverUrl: server.url,
          authorizationCode: code,
          callbackState: state,
          ...(issuer ? { callbackIssuer: issuer } : {}),
        });
      } catch (error) {
        rethrow(server, error);
      }
      return server;
    },

    async connect(ctx, serverId) {
      const server = await serverOf(ctx, serverId);
      if (!server.enabled) throw new McpError("unavailable", `${server.name} is turned off.`);
      let provider: DbAuthProvider | undefined;
      if (server.auth === "oauth") {
        provider = await providerFor(ctx, server);
        if (provider.connection?.status !== "active") throw await signInRequired(ctx, server);
      }
      let client: MCPClient;
      try {
        client = await createMCPClient({
          transport: {
            type: "http",
            url: server.url,
            redirect: "error",
            ...(provider ? { authProvider: provider } : {}),
          },
        });
      } catch (error) {
        if (error instanceof UnauthorizedError) throw await signInRequired(ctx, server);
        return rethrow(server, error);
      }
      const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch (error) {
          if (error instanceof UnauthorizedError) throw await signInRequired(ctx, server);
          return rethrow(server, error);
        }
      };
      if (provider) await store.saveConnection(ctx, server.id, { lastUsedAt: new Date() });

      return {
        listTools: () =>
          guarded(async () => {
            const tools: McpToolInfo[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < PAGE_LIMIT; page += 1) {
              const result = await client.listTools(cursor ? { params: { cursor } } : {});
              for (const tool of result.tools) {
                tools.push({
                  name: tool.name,
                  ...(tool.title ? { title: tool.title } : {}),
                  description: tool.description ?? "",
                  inputSchema: tool.inputSchema as JsonSchema,
                  annotations: { ...(tool.annotations ?? {}) },
                });
              }
              cursor = result.nextCursor;
              if (!cursor) break;
            }
            return tools;
          }),
        callTool: (name, args) =>
          guarded(async () => {
            const result = await client.callTool({ name, arguments: args });
            const content = (result.content ?? []) as Record<string, unknown>[];
            return {
              text: textOf(content),
              isError: result.isError === true,
              ...(result.structuredContent !== undefined
                ? { structured: result.structuredContent }
                : {}),
            };
          }),
        close: () => client.close(),
      };
    },

    async refresh(ctx, serverId) {
      const server = await serverOf(ctx, serverId);
      const provider = await providerFor(ctx, server);
      if (!provider.connection || provider.connection.status === "pending") {
        return "sign_in_required";
      }
      try {
        // Refreshes with the refresh token; without one, or if it was refused,
        // it starts a new sign-in instead, which only the person can finish.
        if ((await auth(provider, { serverUrl: server.url })) === "AUTHORIZED") return "refreshed";
      } catch (error) {
        rethrow(server, error);
      }
      await signInRequired(ctx, server);
      return "sign_in_required";
    },

    disconnect: (ctx, serverId) => store.deleteConnection(ctx, serverId),
  };
}
