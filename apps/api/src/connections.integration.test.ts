import { randomBytes } from "node:crypto";
import { loadConfig } from "@ofa/config";
import {
  mcpServerListSchema,
  mcpServerSchema,
  mcpToolListSchema,
  signInStartSchema,
} from "@ofa/contracts";
import { createDatabase, loadRootEnv, schema, withDatabaseName, withTenant } from "@ofa/db";
import { createMemoryEventBus } from "@ofa/events";
import { startFakeMcpServer, type FakeMcpServer } from "@ofa/mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

// M4.03 end to end against `oneforall_test_api_mcp`: add a custom MCP server,
// sign in through its OAuth (a fake server on 127.0.0.1 that agrees at once),
// come back through the callback, list its tools, sign out, remove it.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("MCP connections API (integration)", async () => {
  const base = loadConfig();
  const dbUrl = withDatabaseName(base.database.url, "oneforall_test_api_mcp");
  const config = {
    ...base,
    database: {
      ...base.database,
      url: dbUrl,
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api_mcp"),
    },
    vault: { ...base.vault, source: "env" as const, key: randomBytes(32).toString("base64") },
  };
  const container = createContainer(config, {
    logger: createLogger({ level: "fatal", format: "json", write: () => {} }),
    bus: createMemoryEventBus(),
  });
  const app = createApp(container);
  const db = createDatabase(dbUrl, { max: 1 });
  let fake: FakeMcpServer;
  afterAll(async () => {
    await fake?.close();
    await container.close();
    await db.close();
  });

  const origin = new URL(config.server.appUrl).origin;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    fake = await startFakeMcpServer();
    const res = await app.request(`${origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        workspaceName: "Connected HQ",
        name: "Morgan Owner",
        email: "morgan@example.com",
        password: "correct-horse-battery",
      }),
    });
    expect(res.status).toBe(201);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  });

  let serverId = "";

  it("adds a custom server only with an explicit yes, and a safe address", async () => {
    const input = { name: "Team Notes", url: fake.mcpUrl };
    expect((await send("POST", "/api/mcp-servers", input)).status).toBe(422);
    const http = { ...input, url: "http://notes.example/mcp", acknowledgeRisk: true };
    expect((await send("POST", "/api/mcp-servers", http)).status).toBe(422);
    const res = await send("POST", "/api/mcp-servers", { ...input, acknowledgeRisk: true });
    expect(res.status).toBe(201);
    const server = mcpServerSchema.parse(await res.json());
    expect(server).toMatchObject({ slug: "team_notes", catalogId: null, connection: null });
    serverId = server.id;
    const again = await send("POST", "/api/mcp-servers", { ...input, acknowledgeRisk: true });
    expect(again.status).toBe(409);
  });

  it("signs in through the provider and comes back to the Connections page", async () => {
    const start = signInStartSchema.parse(
      await (await send("POST", `/api/mcp-servers/${serverId}/connect`)).json(),
    );
    if (start.status !== "redirect") throw new Error("expected a sign-in address");
    expect(start.authorizationUrl.startsWith(`${fake.url}/authorize?`)).toBe(true);

    // The browser: the provider agrees and sends it to our callback.
    const consent = await fetch(start.authorizationUrl, { redirect: "manual" });
    const callback = new URL(consent.headers.get("location") ?? "");
    expect(callback.origin + callback.pathname).toBe(`${origin}/api/connections/callback`);
    const back = await app.request(callback.href, { headers: { cookie } });
    expect(back.status).toBe(302);
    const page = new URL(back.headers.get("location") ?? "");
    expect(page.origin).toBe(config.server.webUrl);
    expect(page.pathname).toBe("/connections");
    expect(page.searchParams.get("connected")).toBe("team_notes");

    const list = mcpServerListSchema.parse(await (await send("GET", "/api/mcp-servers")).json());
    expect(list.items[0]).toMatchObject({
      authOrigin: fake.url,
      connection: { status: "active", lastError: null },
    });
    // Stored sealed; the list never carries a token.
    const [row] = await withTenant(db.db, await tenantOf(), (tx) =>
      tx.select().from(schema.connection),
    );
    expect(row?.credentialsCiphertext?.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(row)).not.toContain("access_token");
    expect(JSON.stringify(list)).not.toMatch(/token":/);
  });

  it("lists the server's tools as the person", async () => {
    const tools = mcpToolListSchema.parse(
      await (await send("GET", `/api/mcp-servers/${serverId}/tools`)).json(),
    );
    expect(tools.items.map((t) => t.name)).toEqual(["search", "delete_page"]);
    expect(tools.items[1]?.annotations).toEqual({ destructiveHint: true });
  });

  it("sends a cancelled or unknown sign-in back with a plain message", async () => {
    const cancelled = await app.request(`${origin}/api/connections/callback?error=access_denied`, {
      headers: { cookie },
    });
    expect(new URL(cancelled.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "Sign-in was cancelled.",
    );
    const unknown = await app.request(`${origin}/api/connections/callback?code=x&state=made-up`, {
      headers: { cookie },
    });
    expect(new URL(unknown.headers.get("location") ?? "").searchParams.get("error")).toMatch(
      /doesn't match one in progress/,
    );
  });

  it("signs out, after which tools need a sign-in again; then removes the server", async () => {
    expect((await send("DELETE", `/api/mcp-servers/${serverId}/connection`)).status).toBe(204);
    const tools = await send("GET", `/api/mcp-servers/${serverId}/tools`);
    expect(tools.status).toBe(400);
    expect(((await tools.json()) as { error: { message: string } }).error.message).toBe(
      "Sign in to Team Notes first.",
    );
    expect((await send("DELETE", `/api/mcp-servers/${serverId}`)).status).toBe(204);
    const actions = (
      await withTenant(db.db, await tenantOf(), (tx) => tx.select().from(schema.auditLog))
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "mcp_server.added",
        "connection.created",
        "connection.removed",
        "mcp_server.removed",
      ]),
    );
  });

  /** The signed-in tenant, from the session. */
  async function tenantOf() {
    const me = (await (await send("GET", "/api/session")).json()) as {
      user: { id: string };
      workspace: { id: string };
    };
    return { workspaceId: me.workspace.id, userId: me.user.id } as never;
  }
});
