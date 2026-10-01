import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { toHttpError } from "../lib/errors";
import { createLogger } from "../lib/logger";
import type { AppEnv } from "../types";
import { hostCheck, originCheck } from "./perimeter";

const ORIGIN = "http://localhost:3000";

function app() {
  const logger = createLogger({ level: "fatal", format: "json", write: () => {} });
  const a = new Hono<AppEnv>();
  a.onError((error, c) => {
    const http = toHttpError(error);
    return c.json(http.body, http.status);
  });
  a.use(async (c, next) => {
    c.set("logger", logger);
    await next();
  });
  a.use(hostCheck(["localhost:3000"]));
  a.use(originCheck([ORIGIN]));
  a.all("/x", (c) => c.text("ok"));
  return a;
}

const url = "http://localhost:3000/x";
const json = { "content-type": "application/json" };

describe("hostCheck", () => {
  it("accepts the configured host", async () => {
    expect((await app().request(url)).status).toBe(200);
  });

  it("rejects other hosts (DNS rebinding)", async () => {
    const res = await app().request("http://attacker.example:3000/x");
    expect(res.status).toBe(403);
  });
});

describe("originCheck", () => {
  it("lets safe methods through without an Origin", async () => {
    expect((await app().request(url, { headers: { cookie: "a=b" } })).status).toBe(200);
  });

  it("accepts a POST from an allowed origin", async () => {
    const res = await app().request(url, {
      method: "POST",
      headers: { ...json, origin: ORIGIN, cookie: "a=b" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a POST from another origin", async () => {
    const res = await app().request(url, {
      method: "POST",
      headers: { ...json, origin: "https://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("falls back to the Referer when Origin is missing", async () => {
    const bad = await app().request(url, {
      method: "POST",
      headers: { ...json, referer: "https://evil.example/page", cookie: "a=b" },
      body: "{}",
    });
    expect(bad.status).toBe(403);
    const good = await app().request(url, {
      method: "POST",
      headers: { ...json, referer: `${ORIGIN}/login`, cookie: "a=b" },
      body: "{}",
    });
    expect(good.status).toBe(200);
  });

  it("rejects a cookie-bearing POST with no Origin or Referer", async () => {
    const res = await app().request(url, {
      method: "POST",
      headers: { ...json, cookie: "a=b" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("allows a cookieless POST with no Origin (curl, scripts)", async () => {
    const res = await app().request(url, { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(200);
  });

  it("requires JSON bodies (blocks form posts)", async () => {
    const res = await app().request(url, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "3",
      },
      body: "a=b",
    });
    expect(res.status).toBe(400);
  });

  it("checks Origin on WebSocket upgrades", async () => {
    const res = await app().request(url, {
      headers: { upgrade: "websocket", origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const missing = await app().request(url, { headers: { upgrade: "websocket" } });
    expect(missing.status).toBe(403);
  });
});
