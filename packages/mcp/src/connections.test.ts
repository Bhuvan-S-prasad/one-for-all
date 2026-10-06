import { asId, McpError, type McpServerRecord, type TenantContext } from "@ofa/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CATALOG,
  catalogEntry,
  createMcpConnections,
  createMemoryConnectionStore,
  plainOf,
  startFakeMcpServer,
  testCipher,
  type FakeMcpServer,
} from "./index";

const alice: TenantContext = { workspaceId: asId("ws"), userId: asId("alice") };
const bob: TenantContext = { workspaceId: asId("ws"), userId: asId("bob") };
const REDIRECT = "http://localhost:3000/api/connections/callback";

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
  let store: ReturnType<typeof createMemoryConnectionStore>;
  let mcp: ReturnType<typeof createMcpConnections>;
  let server: McpServerRecord;

  beforeEach(async () => {
    fake = await startFakeMcpServer();
    store = createMemoryConnectionStore();
    mcp = createMcpConnections({ store, cipher: testCipher, redirectUrl: REDIRECT });
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
    expect(plainOf(connection!.credentials)).toContain("access_token");
    expect(plainOf(connection!.credentials)).not.toContain("codeVerifier");
    expect(plainOf(store.servers.get(server.id)!.client)).toContain("client_id");
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
      const store = createMemoryConnectionStore();
      const entry = {
        ...CATALOG[0]!,
        id: "notes",
        url: fake.mcpUrl,
        authOrigin: fake.url,
        scopes: ["read"],
        authorizationParams: { access_type: "offline" },
      };
      const mcp = createMcpConnections({
        store,
        cipher: testCipher,
        redirectUrl: REDIRECT,
        catalog: [entry],
      });
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
      const store = createMemoryConnectionStore();
      const entry = {
        ...CATALOG[0]!,
        id: "mail",
        url: fake.mcpUrl,
        authOrigin: fake.url,
        setup: "own_client" as const,
        guide: "docs/guides/x.md",
      };
      const mcp = createMcpConnections({
        store,
        cipher: testCipher,
        redirectUrl: REDIRECT,
        catalog: [entry],
      });
      await expect(mcp.install(alice, "mail")).rejects.toMatchObject({
        code: "validation_failed",
      });
      const server = await mcp.install(alice, "mail", {
        clientId: "own-client-id",
        clientSecret: "own-client-secret-123",
      });
      const sealed = plainOf(server.client);
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
