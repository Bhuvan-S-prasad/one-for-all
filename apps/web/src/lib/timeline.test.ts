import type { RunEvent } from "@ofa/contracts";
import { describe, expect, it } from "vitest";
import { timeline } from "./timeline";

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
const auto = (id: string, tool: string) =>
  ev("policy.decided", { toolCallId: id, tool, verdict: "auto", reasons: [] });
const call = (id: string, tool: string, args: unknown) =>
  ev("tool.called", { toolCallId: id, tool, args, idempotencyKey: id });
const done = (id: string, tool: string) =>
  ev("tool.completed", { toolCallId: id, tool, durationMs: 1200, untrusted: true, preview: "" });

describe("timeline", () => {
  it("groups page reads, hides routine checks and says what happened", () => {
    const { items, hiddenChecks } = timeline([
      ev("run.started", { trigger: "message", tier: "fast" }),
      auto("s", "web.search"),
      call("s", "web.search", { query: "harness" }),
      done("s", "web.search"),
      ev("run.tainted", { source: "web.search" }),
      auto("a", "web.read_url"),
      call("a", "web.read_url", { url: "https://lab.example/x" }),
      done("a", "web.read_url"),
      ev("model.called", {
        provider: "p",
        model: "m",
        tier: "fast",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        durationMs: 1,
        finishReason: "tool-calls",
        toolCalls: 1,
      }),
      auto("b", "web.read_url"),
      call("b", "web.read_url", { url: "https://blog.example/y" }),
      ev("tool.failed", {
        toolCallId: "b",
        tool: "web.read_url",
        durationMs: 15000,
        code: "timeout",
        message: "timed out",
      }),
      ev("run.compacted", { tokensBefore: 18400, tokensAfter: 2100 }),
      ev("message.created", { messageId: "m1", preview: "Report" }),
      ev("run.ended", {
        status: "succeeded",
        stopReason: "final_answer",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 2, toolCalls: 3 },
      }),
    ]);
    expect(hiddenChecks).toBe(3);
    expect(items.map((i) => [i.title, i.detail])).toEqual([
      ["Started", "from chat · fast tier"],
      ["Searched the web", "“harness”"],
      ["Read outside content", "From here on, sending anything out needs approval."],
      ["Read 2 pages", "1 read · 1 couldn't load"],
      ["Summarised earlier steps to make room", "18,400 → 2,100 tokens"],
      ["Wrote the answer", null],
    ]);
    expect(items[3]?.children?.map((c) => [c.label, c.state])).toEqual([
      ["lab.example", "done"],
      ["blog.example", "failed"],
    ]);
  });

  it("shows checks that asked or refused, and how a run ended badly", () => {
    const { items } = timeline([
      ev("policy.decided", {
        toolCallId: "x",
        tool: "gmail.send",
        verdict: "deny",
        reasons: ["not granted"],
      }),
      ev("run.ended", {
        status: "failed",
        stopReason: "error",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
        error: { code: "model", message: "No model answered" },
      }),
    ]);
    expect(items.map((i) => [i.title, i.state])).toEqual([
      ["Not allowed to use gmail.send", "warn"],
      ["Failed", "failed"],
    ]);
  });
});
