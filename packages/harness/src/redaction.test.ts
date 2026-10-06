import { asId, type RunContext } from "@ofa/core";
import { describe, expect, it } from "vitest";
import { redactJson } from "./redaction";

const ctx: RunContext = {
  workspaceId: asId("ws"),
  userId: asId("u"),
  agentId: asId("a"),
  runId: asId("r"),
};

describe("redactJson", () => {
  it("replaces a secret anywhere in a value, keys included, in one call", async () => {
    let calls = 0;
    const redact = async (_ctx: RunContext, text: string) => {
      calls += 1;
      return text.split("secret-0123").join("[REDACTED]");
    };
    const value = [{ args: { note: "has secret-0123", n: 1 }, "secret-0123": true }];
    expect(await redactJson(redact, ctx, value)).toEqual([
      { args: { note: "has [REDACTED]", n: 1 }, "[REDACTED]": true },
    ]);
    expect(calls).toBe(1);
  });

  it("returns the value itself when there is nothing to replace", async () => {
    const value = { a: "plain" };
    expect(await redactJson(async (_c, t) => t, ctx, value)).toBe(value);
  });

  it("falls back to each string when a replacement breaks the JSON", async () => {
    // Removing quotes corrupts the serialized JSON; each string alone is fine.
    const raw = async (_ctx: RunContext, text: string) => text.replaceAll('"', "");
    expect(await redactJson(raw, ctx, { note: "ok" })).toEqual({ note: "ok" });
  });
});
