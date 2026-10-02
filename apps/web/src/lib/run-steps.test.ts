import type { RunEvent } from "@ofa/contracts";
import { describe, expect, it } from "vitest";
import { count, timeAgo } from "./format";
import { runSteps } from "./run-steps";

let seq = 0;
const ev = (type: RunEvent["type"], payload: Record<string, unknown>) =>
  ({
    id: `e${seq}`,
    runId: "r",
    seq: seq++,
    createdAt: "2026-10-02T12:00:00Z",
    type,
    payload,
  }) as RunEvent;

describe("runSteps", () => {
  it("turns tool events into plain steps", () => {
    const steps = runSteps([
      ev("policy.decided", { toolCallId: "t0", tool: "web.search", verdict: "auto", reasons: [] }),
      ev("tool.called", {
        toolCallId: "t0",
        tool: "web.search",
        args: { query: "pgvector" },
        idempotencyKey: "k",
      }),
      ev("tool.completed", {
        toolCallId: "t0",
        tool: "web.search",
        durationMs: 9,
        untrusted: true,
        preview: "",
      }),
      ev("tool.called", {
        toolCallId: "t1",
        tool: "web.read_url",
        args: { url: "https://github.com/x" },
        idempotencyKey: "k1",
      }),
    ]);
    expect(steps).toEqual([
      { id: "t0", label: "Searched the web", detail: "pgvector", state: "done" },
      { id: "t1", label: "Reading a page", detail: "github.com", state: "active" },
    ]);
  });

  it("shows blocked and failed calls", () => {
    const steps = runSteps([
      ev("policy.decided", {
        toolCallId: "t0",
        tool: "gmail.send",
        verdict: "deny",
        reasons: ["not granted"],
      }),
      ev("tool.called", {
        toolCallId: "t1",
        tool: "recall",
        args: { query: "x" },
        idempotencyKey: "k",
      }),
      ev("tool.failed", {
        toolCallId: "t1",
        tool: "recall",
        durationMs: 1,
        code: "x",
        message: "boom",
      }),
    ]);
    expect(steps.map((s) => s.state)).toEqual(["blocked", "failed"]);
    expect(steps[1]?.detail).toBe("boom");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  it("speaks in minutes, hours, days", () => {
    expect(timeAgo("2026-10-02T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-10-02T11:30:00Z", now)).toBe("30 min ago");
    expect(timeAgo("2026-10-02T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-09-30T12:00:00Z", now)).toBe("2 d ago");
  });
});

describe("count", () => {
  it("pluralises", () => {
    expect(count(1, "model call")).toBe("1 model call");
    expect(count(0, "tool call")).toBe("0 tool calls");
    expect(count(1042, "token")).toBe("1,042 tokens");
  });
});
