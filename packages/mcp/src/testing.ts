import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ConnectionRecord,
  ConnectionStore,
  McpServerRecord,
  RecordCipher,
  TenantContext,
} from "@ofa/core";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A small remote MCP server with its own OAuth authorization server, on
// 127.0.0.1, for tests: protected-resource and authorization-server metadata,
// dynamic client registration, PKCE authorization codes, refresh tokens, and
// Streamable HTTP JSON-RPC (initialize, tools/list, tools/call). Enough of
// the 2025-11-25 spec to sign in and call tools the way real servers work.

export interface FakeTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, boolean>;
  run(args: Record<string, unknown>): string;
}

export interface FakeMcpServer {
  /** Base address: the authorization server and metadata live here. */
  readonly url: string;
  /** The MCP endpoint. */
  readonly mcpUrl: string;
  readonly counts: { registered: number; authorized: number; refreshed: number; calls: number };
  /** Make every access token issued so far invalid (as if expired). */
  expireAccessTokens(): void;
  /** Refuse refresh tokens from now on (the person revoked access). */
  revokeRefreshTokens(): void;
  /** Advertise a different authorization server (a server that moved its sign-in). */
  advertiseAuthorizationServer(url: string): void;
  /** A Gmail draft for the fake Gmail API at `/gmail/v1` (M4.05). */
  addDraft(id: string, draft: { to: string; subject: string; body: string }): void;
  /** Drafts sent through the fake Gmail API, in order. */
  readonly sentDrafts: string[];
  close(): Promise<void>;
}

const DEFAULT_TOOLS: FakeTool[] = [
  {
    name: "search",
    description: "Search the workspace.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
    run: (args) => `Found 2 pages for "${String(args.query)}".`,
  },
  {
    name: "delete_page",
    description: "Delete a page.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true },
    run: (args) => `Deleted ${String(args.id)}.`,
  },
];

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, value: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

const token = () => randomBytes(18).toString("base64url");

export async function startFakeMcpServer(
  options: { readonly tools?: readonly FakeTool[] } = {},
): Promise<FakeMcpServer> {
  const tools = options.tools ?? DEFAULT_TOOLS;
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const counts = { registered: 0, authorized: 0, refreshed: 0, calls: 0 };
  let refuseRefresh = false;
  let base = "";
  let advertised = "";
  const drafts = new Map<string, { to: string; subject: string; body: string }>();
  const sentDrafts: string[] = [];
  const signedIn = (req: IncomingMessage) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    return bearer !== undefined && accessTokens.has(bearer);
  };

  function issue(res: ServerResponse): void {
    const access = token();
    const refresh = token();
    accessTokens.add(access);
    refreshTokens.add(refresh);
    json(res, 200, {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read write",
    });
  }

  function rpc(message: {
    id?: number | string;
    method: string;
    params?: Record<string, unknown>;
  }) {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        });
      case "tools/list":
        return reply({
          tools: tools.map(({ run: _run, ...tool }) => ({ annotations: {}, ...tool })),
        });
      case "tools/call": {
        counts.calls += 1;
        const tool = tools.find((t) => t.name === message.params?.name);
        if (!tool) {
          return reply({ content: [{ type: "text", text: "No such tool" }], isError: true });
        }
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        return reply({ content: [{ type: "text", text: tool.run(args) }] });
      }
      default:
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        };
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      const path = url.pathname;

      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [advertised] });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (path === "/register" && req.method === "POST") {
        const metadata = JSON.parse(await body(req)) as { redirect_uris: string[] };
        const clientId = `client_${token()}`;
        clients.set(clientId, { redirectUris: metadata.redirect_uris });
        counts.registered += 1;
        return json(res, 201, {
          ...metadata,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        });
      }
      if (path === "/authorize") {
        // A real server shows a consent page; this one agrees at once.
        const q = url.searchParams;
        const clientId = q.get("client_id") ?? "";
        const redirectUri = q.get("redirect_uri") ?? "";
        if (!clients.get(clientId)?.redirectUris.includes(redirectUri)) {
          return json(res, 400, { error: "invalid_request" });
        }
        if (q.get("code_challenge_method") !== "S256") {
          return json(res, 400, { error: "invalid_request" });
        }
        const code = token();
        codes.set(code, { clientId, redirectUri, challenge: q.get("code_challenge") ?? "" });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        back.searchParams.set("iss", base);
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (path === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await body(req));
        if (form.get("grant_type") === "authorization_code") {
          const grant = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (
            !grant ||
            grant.clientId !== form.get("client_id") ||
            grant.redirectUri !== form.get("redirect_uri") ||
            grant.challenge !== challenge
          ) {
            return json(res, 400, { error: "invalid_grant" });
          }
          counts.authorized += 1;
          return issue(res);
        }
        if (form.get("grant_type") === "refresh_token") {
          const refresh = form.get("refresh_token") ?? "";
          if (refuseRefresh || !refreshTokens.delete(refresh)) {
            return json(res, 400, { error: "invalid_grant" });
          }
          counts.refreshed += 1;
          return issue(res);
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (path.startsWith("/gmail/v1/users/me/drafts")) {
        // Just enough of the Gmail API for gmail.send_draft.
        if (!signedIn(req)) return json(res, 401, { error: { code: 401 } });
        if (path === "/gmail/v1/users/me/drafts/send" && req.method === "POST") {
          const { id } = JSON.parse(await body(req)) as { id: string };
          if (!drafts.delete(id)) return json(res, 404, { error: { code: 404 } });
          sentDrafts.push(id);
          return json(res, 200, { id: `msg_${id}`, threadId: `thread_${id}` });
        }
        const id = decodeURIComponent(path.split("/").pop() ?? "");
        const draft = drafts.get(id);
        if (!draft) return json(res, 404, { error: { code: 404 } });
        return json(res, 200, {
          id,
          message: {
            snippet: draft.body.slice(0, 100),
            payload: {
              headers: [
                { name: "To", value: draft.to },
                { name: "Subject", value: draft.subject },
              ],
            },
          },
        });
      }
      if (path === "/mcp") {
        if (req.method !== "POST") {
          res.writeHead(405);
          return res.end();
        }
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
        if (!bearer || !accessTokens.has(bearer)) {
          return json(
            res,
            401,
            { error: "invalid_token" },
            {
              "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
        }
        const parsed = JSON.parse(await body(req)) as
          Parameters<typeof rpc>[0] | Parameters<typeof rpc>[0][];
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const replies = messages.filter((m) => m.id !== undefined).map(rpc);
        if (replies.length === 0) {
          res.writeHead(202);
          return res.end();
        }
        return json(res, 200, Array.isArray(parsed) ? replies : replies[0]);
      }
      json(res, 404, { error: "not_found" });
    })().catch((error: unknown) => json(res, 500, { error: String(error) }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  advertised = base;

  return {
    url: base,
    mcpUrl: `${base}/mcp`,
    counts,
    expireAccessTokens: () => accessTokens.clear(),
    revokeRefreshTokens: () => void (refuseRefresh = true),
    advertiseAuthorizationServer: (url) => void (advertised = url),
    addDraft: (id, draft) => void drafts.set(id, draft),
    sentDrafts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// In-memory stand-ins for unit tests: no database, no vault.

/** Seals visibly, and refuses to open a value under another row's scope (like the vault). */
export const testCipher: RecordCipher = {
  seal: (_ctx, scope, value) => ({
    valueCiphertext: Buffer.from(JSON.stringify({ scope, value })).toString("base64"),
    keyCiphertext: "k",
    keyId: "test",
  }),
  open: (_ctx, scope, sealed) => {
    const { scope: bound, value } = JSON.parse(
      Buffer.from(sealed.valueCiphertext, "base64").toString("utf8"),
    ) as { scope: typeof scope; value: string };
    if (bound.table !== scope.table || bound.id !== scope.id) throw new Error("wrong row");
    return value;
  },
};
export const plainOf = (sealed: { valueCiphertext: string } | null) =>
  sealed ? Buffer.from(sealed.valueCiphertext, "base64").toString("utf8") : "";

export function createMemoryConnectionStore(): ConnectionStore & {
  servers: Map<string, McpServerRecord>;
  connections: Map<string, ConnectionRecord>;
} {
  const servers = new Map<string, McpServerRecord>();
  const connections = new Map<string, ConnectionRecord>();
  const key = (ctx: TenantContext, serverId: string) => `${serverId}:${ctx.userId}`;
  return {
    servers,
    connections,
    getServer: async (_ctx, id) => servers.get(id) ?? null,
    listServers: async () => [...servers.values()],
    async createServer(_ctx, input) {
      // Like the unique indexes: one per slug, and one per catalog entry.
      const taken = [...servers.values()].some(
        (s) => s.slug === input.slug || (input.catalogId && s.catalogId === input.catalogId),
      );
      if (taken) return null;
      const record: McpServerRecord = {
        id: randomUUID(),
        slug: input.slug,
        name: input.name,
        url: input.url,
        catalogId: input.catalogId ?? null,
        auth: input.auth ?? "oauth",
        authOrigin: input.authOrigin ?? null,
        client: null,
        enabled: true,
        tools: null,
        toolsFetchedAt: null,
        createdAt: new Date(),
      };
      servers.set(record.id, record);
      return record;
    },
    deleteServer: async (_ctx, id) => servers.delete(id),
    async saveServerTools(_ctx, id, tools) {
      servers.set(id, { ...servers.get(id)!, tools, toolsFetchedAt: new Date() });
    },
    async saveServerClient(_ctx, id, client) {
      servers.set(id, { ...servers.get(id)!, client });
    },
    async pinAuthOrigin(_ctx, id, origin) {
      const server = servers.get(id)!;
      if (!server.authOrigin) servers.set(id, { ...server, authOrigin: origin });
      return servers.get(id)!.authOrigin!;
    },
    getConnection: async (ctx, serverId) => connections.get(key(ctx, serverId)) ?? null,
    findConnectionByState: async (ctx, state) =>
      [...connections.values()].find((c) => c.oauthState === state && c.userId === ctx.userId) ??
      null,
    listConnections: async (ctx) =>
      [...connections.values()].filter((c) => c.userId === ctx.userId),
    async saveConnection(ctx, serverId, patch) {
      const existing = connections.get(key(ctx, serverId));
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ) as Partial<ConnectionRecord>;
      const next: ConnectionRecord = {
        id: existing?.id ?? randomUUID(),
        mcpServerId: serverId,
        userId: ctx.userId,
        status: "pending",
        account: null,
        scopes: [],
        credentials: null,
        oauthState: null,
        expiresAt: null,
        refreshedAt: null,
        lastUsedAt: null,
        lastError: null,
        ...existing,
        ...defined,
        updatedAt: new Date(),
      };
      connections.set(key(ctx, serverId), next);
      return next;
    },
    deleteConnection: async (ctx, serverId) => connections.delete(key(ctx, serverId)),
  };
}
