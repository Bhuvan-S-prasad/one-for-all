import { randomUUID } from "node:crypto";
import {
  asId,
  McpError,
  type ConnectionRecord,
  type ConnectionStore,
  type McpServerRecord,
  type RecordCipher,
  type TenantContext,
} from "@ofa/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CATALOG,
  catalogEntry,
  createMcpConnections,
  startFakeMcpServer,
  type FakeMcpServer,
} from "./index";

const alice: TenantContext = { workspaceId: asId("ws"), userId: asId("alice") };
const bob: TenantContext = { workspaceId: asId("ws"), userId: asId("bob") };
const REDIRECT = "http://localhost:3000/api/connections/callback";

/** Seals visibly, and refuses to open a value under another row's scope (like the vault). */
const cipher: RecordCipher = {
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
const plain = (sealed: { valueCiphertext: string } | null) =>
  sealed ? Buffer.from(sealed.valueCiphertext, "base64").toString("utf8") : "";

function memoryStore(): ConnectionStore & {
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
        createdAt: new Date(),
      };
      servers.set(record.id, record);
      return record;
    },
    deleteServer: async (_ctx, id) => servers.delete(id),
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

/** What a browser does: open the sign-in page (the fake agrees at once) and follow it back. */
async function consent(authorizationUrl: string) {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location") ?? "");
  expect(back.origin + back.pathname).toBe(REDIRECT);
  return {
    code: back.searchParams.get("code") ?? "",
    state: back.searchParams.get("state") ?? "",
    issuer: back.searchParams.get("iss") ?? "",
  };
}

describe("MCP connections", () => {
  let fake: FakeMcpServer;
  let store: ReturnType<typeof memoryStore>;
  let mcp: ReturnType<typeof createMcpConnections>;
  let server: McpServerRecord;

  beforeEach(async () => {
    fake = await startFakeMcpServer();
    store = memoryStore();
    mcp = createMcpConnections({ store, cipher, redirectUrl: REDIRECT });
    server = (await store.createServer(alice, { slug: "notes", name: "Notes", url: fake.mcpUrl }))!;
  });
  afterEach(() => fake.close());

  async function signIn(ctx: TenantContext) {
    const start = await mcp.startSignIn(ctx, server.id);
    if (start.status !== "redirect") throw new Error("expected a sign-in address");
    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(fake.mcpUrl);
    return mcp.finishSignIn(ctx, await consent(start.authorizationUrl));
  }

  it("signs in with PKCE and a registered client, then lists and calls tools", async () => {
    expect((await signIn(alice)).id).toBe(server.id);
    const connection = await store.getConnection(alice, server.id);
    expect(connection).toMatchObject({
      status: "active",
      oauthState: null,
      scopes: ["read", "write"],
    });
    expect(connection?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    // Sealed, bound to the row, and holding tokens only once signed in.
    expect(plain(connection!.credentials)).toContain("access_token");
    expect(plain(connection!.credentials)).not.toContain("codeVerifier");
    expect(plain(store.servers.get(server.id)!.client)).toContain("client_id");
    // The sign-in site is pinned at the first sign-in.
    expect(store.servers.get(server.id)!.authOrigin).toBe(fake.url);

    const session = await mcp.connect(alice, server.id);
    const tools = await session.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "delete_page"]);
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(await session.callTool("search", { query: "roadmap" })).toEqual({
      text: 'Found 2 pages for "roadmap".',
      isError: false,
    });
    expect((await session.callTool("missing", {})).isError).toBe(true);
    await session.close();
  });

  it("registers once per server: a second person reuses the client", async () => {
    await signIn(alice);
    await signIn(bob);
    expect(fake.counts.registered).toBe(1);
    expect((await store.listConnections(bob)).map((c) => c.status)).toEqual(["active"]);
  });

  it("refreshes an expired token by itself, and on request", async () => {
    await signIn(alice);
    fake.expireAccessTokens();
    const session = await mcp.connect(alice, server.id);
    expect((await session.callTool("search", { query: "x" })).isError).toBe(false);
    expect(fake.counts.refreshed).toBe(1);
    await session.close();
    expect(await mcp.refresh(alice, server.id)).toBe("refreshed");
    expect(fake.counts.refreshed).toBe(2);
    expect((await store.getConnection(alice, server.id))?.refreshedAt).toBeInstanceOf(Date);
  });

  it("asks the person to sign in again once the refresh token is refused", async () => {
    await signIn(alice);
    fake.expireAccessTokens();
    fake.revokeRefreshTokens();
    await expect(mcp.connect(alice, server.id)).rejects.toMatchObject({
      reason: "sign_in_required",
    });
    expect(await store.getConnection(alice, server.id)).toMatchObject({
      status: "needs_reauth",
      lastError: "The sign-in expired. Sign in again.",
    });
    expect(await mcp.refresh(alice, server.id)).toBe("sign_in_required");
  });

  it("refuses a server that moves its sign-in elsewhere", async () => {
    await signIn(alice);
    await mcp.disconnect(alice, server.id);
    // Same machine, another origin: the client itself would allow it.
    fake.advertiseAuthorizationServer(fake.url.replace("127.0.0.1", "localhost"));
    const moved = await mcp.startSignIn(alice, server.id).catch((e: unknown) => e);
    expect(moved).toBeInstanceOf(McpError);
    expect(moved).toMatchObject({ reason: "auth_origin_mismatch" });
    expect(fake.counts.authorized).toBe(1);
  });

  it("refuses a sign-in that doesn't match one in progress, and one without a sign-in", async () => {
    await expect(mcp.finishSignIn(alice, { state: "made-up", code: "x" })).rejects.toMatchObject({
      reason: "sign_in_unknown",
    });
    const start = await mcp.startSignIn(alice, server.id);
    if (start.status !== "redirect") throw new Error("expected a sign-in address");
    const back = await consent(start.authorizationUrl);
    // Bob can't finish Alice's sign-in.
    await expect(mcp.finishSignIn(bob, back)).rejects.toMatchObject({ reason: "sign_in_unknown" });
    await expect(mcp.connect(bob, server.id)).rejects.toMatchObject({ reason: "sign_in_required" });
  });
});

describe("the catalog", () => {
  it("loads every entry pinned to https, one per id", () => {
    expect(CATALOG.map((e) => e.id)).toEqual([
      "notion",
      "linear",
      "github",
      "slack",
      "gmail",
      "google_calendar",
      "google_drive",
    ]);
    for (const entry of CATALOG) {
      expect(entry.url.startsWith("https://")).toBe(true);
      expect(entry.setup === "automatic" || entry.guide).toBeTruthy();
    }
    expect(catalogEntry("gmail")?.authorizationParams).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
  });

  it("installs an entry pinned to its sign-in site, and asks only for its scopes", async () => {
    const fake = await startFakeMcpServer();
    try {
      const store = memoryStore();
      const entry = {
        ...CATALOG[0]!,
        id: "notes",
        url: fake.mcpUrl,
        authOrigin: fake.url,
        scopes: ["read"],
        authorizationParams: { access_type: "offline" },
      };
      const mcp = createMcpConnections({ store, cipher, redirectUrl: REDIRECT, catalog: [entry] });
      const server = await mcp.install(alice, "notes");
      expect(server).toMatchObject({ slug: "notes", catalogId: "notes", authOrigin: fake.url });
      await expect(mcp.install(alice, "notes")).rejects.toMatchObject({ code: "conflict" });
      const start = await mcp.startSignIn(alice, server.id);
      if (start.status !== "redirect") throw new Error("expected a sign-in address");
      const url = new URL(start.authorizationUrl);
      expect(url.searchParams.get("scope")).toBe("read");
      expect(url.searchParams.get("access_type")).toBe("offline");
    } finally {
      await fake.close();
    }
  });

  it("uses the self-hoster's own OAuth app where the server can't register one", async () => {
    const fake = await startFakeMcpServer();
    try {
      const store = memoryStore();
      const entry = {
        ...CATALOG[0]!,
        id: "mail",
        url: fake.mcpUrl,
        authOrigin: fake.url,
        setup: "own_client" as const,
        guide: "docs/guides/x.md",
      };
      const mcp = createMcpConnections({ store, cipher, redirectUrl: REDIRECT, catalog: [entry] });
      await expect(mcp.install(alice, "mail")).rejects.toMatchObject({
        code: "validation_failed",
      });
      const server = await mcp.install(alice, "mail", {
        clientId: "own-client-id",
        clientSecret: "own-client-secret-123",
      });
      const sealed = plain(server.client);
      expect(sealed).toContain("own-client-secret-123");
      expect(sealed).toContain('\\"dynamic\\":false');
      const start = await mcp.startSignIn(alice, server.id);
      if (start.status !== "redirect") throw new Error("expected a sign-in address");
      expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe("own-client-id");
      expect(fake.counts.registered).toBe(0);
    } finally {
      await fake.close();
    }
  });
});
