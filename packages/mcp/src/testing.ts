import { createHash, randomBytes } from "node:crypto";
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
