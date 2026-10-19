import { loadConfig } from "@ofa/config";
import { sessionResponseSchema, setupStatusSchema } from "@ofa/contracts";
import { loadRootEnv, withDatabaseName } from "@ofa/db";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

// End to end through the HTTP app against `oneforall_test_api`, which
// `pnpm test:integration` recreates before this runs.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("API (integration)", () => {
  const base = loadConfig();
  const config = {
    ...base,
    database: {
      ...base.database,
      url: withDatabaseName(base.database.url, "oneforall_test_api"),
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api"),
    },
  };
  const container = createContainer(config, {
    logger: createLogger({ level: "fatal", format: "json", write: () => {} }),
  });
  const app = createApp(container);
  afterAll(() => container.close());

  const origin = new URL(config.server.appUrl).origin;
  const url = (path: string) => `${origin}${path}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...headers },
      body: JSON.stringify(body),
    });

  const owner = {
    workspaceName: "Test HQ",
    name: "Olivia Owner",
    email: "olivia@example.com",
    password: "correct-horse-battery",
  };
  let cookie = "";

  /** `name=value` pairs from Set-Cookie headers, as a Cookie header. */
  const cookieFrom = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

  it("reports health", async () => {
    const res = await app.request(url("/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", checks: { database: "ok" } });
  });

  it("keeps JSON bodies small, except for Inngest, whose steps carry a run's whole state", async () => {
    const big = JSON.stringify({ filler: "x".repeat(1_500_000) });
    const send = (path: string) =>
      app.request(url(path), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "content-length": String(big.length),
        },
        body: big,
      });
    const limited = `{"error":{"code":"bad_request","message":"bad_request"}}`;
    const refused = await send("/api/session");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(limited);
    // Whatever Inngest's own handler says about this body, it isn't our size limit.
    expect(await (await send("/api/inngest")).text()).not.toBe(limited);
  });

  it("needs setup on a fresh install", async () => {
    const res = await app.request(url("/api/setup"));
    expect(setupStatusSchema.parse(await res.json())).toEqual({ needsSetup: true });
  });

  it("rejects invalid setup input with field messages", async () => {
    const res = await post("/api/setup", { ...owner, password: "short" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { issues: { path: string }[] } } };
    expect(body.error.details.issues.map((i) => i.path)).toContain("password");
  });

  it("first-run setup creates the owner and signs them in", async () => {
    const res = await post("/api/setup", owner);
    expect(res.status).toBe(201);
    const session = sessionResponseSchema.parse(await res.json());
    expect(session.user.email).toBe(owner.email);
    expect(session.workspace).toMatchObject({ name: "Test HQ", role: "owner" });

    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/ofa\.session_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    cookie = cookieFrom(res);
  });

  it("setup cannot run twice", async () => {
    const res = await post("/api/setup", { ...owner, email: "mallory@example.com" });
    expect(res.status).toBe(409);
    expect(setupStatusSchema.parse(await (await app.request(url("/api/setup"))).json())).toEqual({
      needsSetup: false,
    });
  });

  it("returns the session for the cookie", async () => {
    const res = await app.request(url("/api/session"), { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(sessionResponseSchema.parse(await res.json()).workspace?.name).toBe("Test HQ");
  });

  it("rejects a workspace the user is not a member of", async () => {
    const res = await app.request(url("/api/session"), {
      headers: { cookie, "x-workspace-id": "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status).toBe(403);
  });

  it("blocks cross-origin writes that carry the cookie", async () => {
    const res = await app.request(url("/api/session"), {
      method: "DELETE",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const still = await app.request(url("/api/session"), { headers: { cookie } });
    expect(still.status).toBe(200);
  });

  it("logs out", async () => {
    const res = await app.request(url("/api/session"), {
      method: "DELETE",
      headers: { cookie, origin },
    });
    expect(res.status).toBe(204);
    const after = await app.request(url("/api/session"), { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it("rejects a wrong password with a generic message", async () => {
    const res = await post("/api/session", { email: owner.email, password: "wrong-password!" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Email or password is incorrect" },
    });
  });

  it("logs in with email and password", async () => {
    const res = await post("/api/session", { email: owner.email, password: owner.password });
    expect(res.status).toBe(200);
    const session = sessionResponseSchema.parse(await res.json());
    expect(session.workspace?.role).toBe("owner");
    const me = await app.request(url("/api/session"), { headers: { cookie: cookieFrom(res) } });
    expect(me.status).toBe(200);
  });

  it("answers unknown API paths with JSON 404", async () => {
    const res = await app.request(url("/api/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("sets security headers", async () => {
    const res = await app.request(url("/api/health"));
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
