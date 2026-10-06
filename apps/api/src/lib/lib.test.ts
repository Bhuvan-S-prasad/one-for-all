import { AppError } from "@ofa/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { toHttpError } from "./errors";
import { createLogger } from "./logger";
import { rateLimit } from "./rate-limit";

describe("toHttpError", () => {
  it("maps AppError codes to statuses", () => {
    const http = toHttpError(new AppError("conflict", "Already done"));
    expect(http.status).toBe(409);
    expect(http.body).toEqual({ error: { code: "conflict", message: "Already done" } });
    expect(http.unexpected).toBe(false);
  });

  it("hides unexpected errors", () => {
    const http = toHttpError(new Error("password=hunter2 leaked in a stack"));
    expect(http.status).toBe(500);
    expect(JSON.stringify(http.body)).not.toContain("hunter2");
    expect(http.unexpected).toBe(true);
  });

  it("maps Hono HTTP exceptions", () => {
    expect(
      toHttpError(new HTTPException(413, { message: "Payload Too Large" })).body.error.code,
    ).toBe("bad_request");
  });
});

describe("rateLimit", () => {
  it("blocks after max requests in the window, then resets", async () => {
    let now = 0;
    const app = new Hono();
    app.onError((error, c) => c.json(toHttpError(error).body, toHttpError(error).status));
    app.use(rateLimit({ windowMs: 1000, max: 2, key: () => "ip", now: () => now }));
    app.get("/", (c) => c.text("ok"));

    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(200);
    const blocked = await app.request("/");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");

    now = 1000;
    expect((await app.request("/")).status).toBe(200);
  });
});

describe("createLogger", () => {
  it("filters by level and adds child fields", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", format: "json", write: (l) => lines.push(l) });
    logger.debug("hidden");
    logger.child({ requestId: "r1" }).info("shown", { status: 200 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "info",
      msg: "shown",
      requestId: "r1",
      status: 200,
    });
  });

  it("redacts every line, errors included", () => {
    const lines: string[] = [];
    const secret = "secret-value-0123";
    const logger = createLogger({
      level: "info",
      format: "pretty",
      write: (l) => lines.push(l),
      redact: (text) => text.split(secret).join("[REDACTED]"),
    });
    logger.error(`saw ${secret}`, { error: new Error(`bad ${secret}`), key: secret });
    expect(lines[0]).toContain("saw [REDACTED]");
    expect(lines[0]).not.toContain(secret);
  });
});
