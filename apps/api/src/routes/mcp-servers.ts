import {
  addMcpServerSchema,
  installCatalogSchema,
  oauthCallbackQuerySchema,
  ownClientSchema,
  type CatalogList,
  type McpServer,
  type McpServerList,
  type McpToolList,
  type SignInStartResponse,
  type AppToolList,
  type ToolRefreshResponse,
} from "@ofa/contracts";
import {
  AppError,
  ForbiddenError,
  McpError,
  NotFoundError,
  type ConnectionRecord,
  type McpServerRecord,
  type TenantContext,
} from "@ofa/core";
import { recordAudit } from "@ofa/db";
import { CATALOG, type McpConnections } from "@ofa/mcp";
import { Hono, type Context } from "hono";
import type { Container } from "../container";
import { requestMeta } from "../lib/request";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Apps through MCP servers (ARCHITECTURE.md §9, M4.03):
 *   GET    /api/mcp-servers                  installed servers, with your connection to each
 *   GET    /api/mcp-servers/catalog          the reviewed apps, and the callback to register
 *   POST   /api/mcp-servers/catalog/:entry   add one (owner or admin), with your own OAuth app if it needs one
 *   PUT    /api/mcp-servers/:id/client       replace that OAuth app (owner or admin)
 *   POST   /api/mcp-servers                  add a custom server (owner or admin, ADR-0018)
 *   DELETE /api/mcp-servers/:id              remove one, with everyone's connections (owner or admin)
 *   POST   /api/mcp-servers/:id/connect      start signing in: { authorizationUrl } to open
 *   DELETE /api/mcp-servers/:id/connection   sign out of it
 *   GET    /api/mcp-servers/:id/tools        what it offers, as you
 *   POST   /api/mcp-servers/:id/tools/refresh  fetch and keep its tool list again (agents use the kept one)
 *   GET    /api/mcp-servers/:id/agent-tools    the kept list as agents see it (`notion.search`), for grants
 *   GET    /api/connections/callback         where the provider sends you back
 *
 * Tokens stay inside the MCP client; nothing here returns one.
 */
export function mcpServerRoutes(
  deps: Pick<
    Container,
    "db" | "sessions" | "connections" | "mcp" | "toolkits" | "config" | "logger"
  >,
) {
  function requireAdmin(c: Context<AppEnv>): TenantContext {
    const role = c.get("session").membership?.role;
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenError("Only an owner or admin can add or remove servers");
    }
    return c.get("tenant");
  }

  function client(): McpConnections {
    if (!deps.mcp) {
      throw new AppError(
        "internal",
        "Connections need a vault key to keep sign-ins encrypted: set VAULT_KEY (infra/scripts/init-env.sh).",
      );
    }
    return deps.mcp;
  }

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const tenant = c.get("tenant");
      const [servers, connections] = await Promise.all([
        deps.connections.listServers(tenant),
        deps.connections.listConnections(tenant),
      ]);
      const byServer = new Map(connections.map((x) => [x.mcpServerId, x]));
      const items = servers.map((s) => toMcpServer(s, byServer.get(s.id) ?? null));
      return c.json({ items } satisfies McpServerList);
    })
    .get("/catalog", async (c) => {
      const servers = await deps.connections.listServers(c.get("tenant"));
      const installed = new Map(servers.map((s) => [s.catalogId, s.id]));
      const items = CATALOG.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        setup: entry.setup,
        guide: entry.guide ?? null,
        serverId: installed.get(entry.id) ?? null,
      }));
      const redirectUrl = new URL("/api/connections/callback", deps.config.server.appUrl).href;
      return c.json({ items, redirectUrl } satisfies CatalogList);
    })
    .post("/catalog/:entry", async (c) => {
      const tenant = requireAdmin(c);
      const { client: own } = await readJson(c, installCatalogSchema);
      const server = await client().install(tenant, c.req.param("entry"), own);
      await recordAudit(deps.db, tenant, {
        action: "mcp_server.added",
        targetType: "mcp_server",
        targetId: server.id,
        data: { slug: server.slug, catalogId: server.catalogId, ownClient: Boolean(own) },
        ...requestMeta(c),
      });
      return c.json(toMcpServer(server, null), 201);
    })
    .put("/:id/client", async (c) => {
      const tenant = requireAdmin(c);
      const own = await readJson(c, ownClientSchema);
      const server = await deps.connections.getServer(tenant, c.req.param("id"));
      if (!server) throw new NotFoundError("Server");
      await client().setClient(tenant, server.id, own);
      await recordAudit(deps.db, tenant, {
        action: "mcp_server.client_set",
        targetType: "mcp_server",
        targetId: server.id,
        // The client ID is public; the secret never goes in the audit log.
        data: { slug: server.slug, clientId: own.clientId },
        ...requestMeta(c),
      });
      return c.body(null, 204);
    })
    .post("/", async (c) => {
      const tenant = requireAdmin(c);
      const input = await readJson(c, addMcpServerSchema);
      const url = new URL(input.url);
      if (!serverUrlAllowed(url, deps.config.env)) {
        throw new AppError(
          "validation_failed",
          "Use an https:// address for the server (plain http only reaches this computer).",
        );
      }
      const slug = input.slug ?? slugFrom(input.name);
      if (!slug) throw new AppError("validation_failed", "Give the server a short name (slug)");
      const created = await deps.connections.createServer(tenant, {
        slug,
        name: input.name,
        url: url.href,
        auth: input.auth,
      });
      if (!created) throw new AppError("conflict", `A server called ${slug} is already added`);
      await recordAudit(deps.db, tenant, {
        action: "mcp_server.added",
        targetType: "mcp_server",
        targetId: created.id,
        data: { slug, url: created.url, custom: true },
        ...requestMeta(c),
      });
      return c.json(toMcpServer(created, null), 201);
    })
    .delete("/:id", async (c) => {
      const tenant = requireAdmin(c);
      const server = await deps.connections.getServer(tenant, c.req.param("id"));
      if (!server) throw new NotFoundError("Server");
      await deps.connections.deleteServer(tenant, server.id);
      await recordAudit(deps.db, tenant, {
        action: "mcp_server.removed",
        targetType: "mcp_server",
        targetId: server.id,
        data: { slug: server.slug },
        ...requestMeta(c),
      });
      return c.body(null, 204);
    })
    .post("/:id/connect", async (c) => {
      const tenant = c.get("tenant");
      const result = await client().startSignIn(tenant, c.req.param("id"));
      if (result.status === "connected") {
        // No sign-in page to come back from: keep its tool list for agents now.
        await deps.toolkits?.refresh(tenant, c.req.param("id")).catch((error: unknown) => {
          deps.logger.warn("mcp: couldn't fetch tools after connecting", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return c.json(result satisfies SignInStartResponse);
    })
    .delete("/:id/connection", async (c) => {
      const tenant = c.get("tenant");
      const server = await deps.connections.getServer(tenant, c.req.param("id"));
      if (!server) throw new NotFoundError("Server");
      if (await client().disconnect(tenant, server.id)) {
        await recordAudit(deps.db, tenant, {
          action: "connection.removed",
          targetType: "mcp_server",
          targetId: server.id,
          data: { slug: server.slug },
          ...requestMeta(c),
        });
      }
      return c.body(null, 204);
    })
    .get("/:id/agent-tools", async (c) => {
      if (!deps.toolkits) client();
      const kit = await deps.toolkits!.forServer(c.get("tenant"), c.req.param("id"));
      const items = (kit?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.annotations.readOnly === true,
        destructive: tool.annotations.destructive === true,
      }));
      return c.json({ items } satisfies AppToolList);
    })
    .post("/:id/tools/refresh", async (c) => {
      if (!deps.toolkits) client();
      const count = await deps.toolkits!.refresh(c.get("tenant"), c.req.param("id"));
      return c.json({ count } satisfies ToolRefreshResponse);
    })
    .get("/:id/tools", async (c) => {
      const session = await client().connect(c.get("tenant"), c.req.param("id"));
      try {
        const items = await session.listTools();
        return c.json({ items } satisfies McpToolList);
      } finally {
        await session.close();
      }
    });
}

/**
 * The provider sends the person here after they agree (or decline). It is a
 * top-level navigation, so the session cookie comes along; the sign-in is
 * matched to the one this person started by its `state`. Ends on the web
 * app's Connections page, saying how it went.
 */
export function connectionCallbackRoutes(
  deps: Pick<Container, "db" | "sessions" | "mcp" | "toolkits" | "config" | "logger">,
) {
  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/callback", async (c) => {
      const tenant = c.get("tenant");
      const query = readQuery(c, oauthCallbackQuerySchema);
      const back = new URL("/connections", deps.config.server.webUrl);
      if (!deps.mcp) {
        back.searchParams.set("error", "Connections need a vault key (VAULT_KEY).");
        return c.redirect(back.href);
      }
      if (query.error || !query.code || !query.state) {
        back.searchParams.set(
          "error",
          query.error === "access_denied"
            ? "Sign-in was cancelled."
            : "The sign-in didn't finish. Try again.",
        );
        return c.redirect(back.href);
      }
      try {
        const server = await deps.mcp.finishSignIn(tenant, {
          state: query.state,
          code: query.code,
          ...(query.iss ? { issuer: query.iss } : {}),
        });
        await recordAudit(deps.db, tenant, {
          action: "connection.created",
          targetType: "mcp_server",
          targetId: server.id,
          data: { slug: server.slug },
          ...requestMeta(c),
        });
        // Keep its tool list for agents now; a failure here only delays that.
        await deps.toolkits?.refresh(tenant, server.id).catch((error: unknown) => {
          deps.logger.warn("mcp: couldn't fetch tools after sign-in", {
            server: server.slug,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        back.searchParams.set("connected", server.slug);
      } catch (error) {
        if (!(error instanceof McpError)) throw error;
        back.searchParams.set("error", error.message);
      }
      return c.redirect(back.href);
    });
}

/** https anywhere; plain http only to this computer, and not in production. */
export function serverUrlAllowed(url: URL, env: string): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "http:" && loopback && env !== "production";
}

function slugFrom(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 32);
  return /^[a-z][a-z0-9_]{0,31}$/.test(slug) ? slug : null;
}

function toMcpServer(server: McpServerRecord, connection: ConnectionRecord | null): McpServer {
  return {
    id: server.id,
    slug: server.slug,
    name: server.name,
    catalogId: server.catalogId,
    url: server.url,
    auth: server.auth,
    authOrigin: server.authOrigin,
    enabled: server.enabled,
    toolCount: server.tools?.length ?? null,
    toolsFetchedAt: server.toolsFetchedAt?.toISOString() ?? null,
    connection: connection
      ? {
          status: connection.status,
          lastError: connection.lastError,
          expiresAt: connection.expiresAt?.toISOString() ?? null,
          lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
        }
      : null,
    createdAt: server.createdAt.toISOString(),
  };
}
