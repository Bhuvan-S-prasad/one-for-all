import type { RunEvent } from "@ofa/contracts";
import { describe, expect, it } from "vitest";
import { count, timeAgo } from "./format";
import {
  runPhase,
  runPlan,
  runSources,
  runSteps,
  runSummary,
  sourceFor,
  summaryLine,
} from "./run-steps";

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

describe("sources, summary and phase", () => {
  const call = (id: string, tool: string, args: unknown) =>
    ev("tool.called", { toolCallId: id, tool, args, idempotencyKey: id });
  const done = (id: string, tool: string, preview = "") =>
    ev("tool.completed", { toolCallId: id, tool, durationMs: 5, untrusted: true, preview });
  const failed = (id: string, tool: string) =>
    ev("tool.failed", {
      toolCallId: id,
      tool,
      durationMs: 5,
      code: "timeout",
      message: "timed out",
    });

  const events = [
    ev("run.started", { trigger: "message", tier: "fast" }),
    call("t0", "web.search", { query: "harness" }),
    done("t0", "web.search"),
    call("t1", "web.read_url", { url: "https://www.lab.example/a/" }),
    done("t1", "web.read_url", "Source: https://lab.example/a\n\n# What a harness is\n\nText"),
    call("t2", "web.read_url", { url: "https://blog.example/b" }),
    failed("t2", "web.read_url"),
    call("t3", "web.read_url", { url: "https://lab.example/a", from: 6000 }),
    done("t3", "web.read_url", "Source: https://lab.example/a\n\nmore text"),
    call("t4", "web.read_url", { url: "https://notes.example/c" }),
  ];

  it("numbers pages the agent read, once each, and keeps failures apart", () => {
    const sources = runSources(events);
    expect(sources.map((s) => [s.host, s.state, s.n])).toEqual([
      ["lab.example", "read", 1],
      ["blog.example", "failed", null],
      ["notes.example", "reading", null],
    ]);
    expect(sources[0]?.title).toBe("What a harness is");
    // A link the model wrote matches only a page it read.
    expect(sourceFor(sources, "https://lab.example/a#intro")?.n).toBe(1);
    expect(sourceFor(sources, "https://made-up.example/a")).toBeNull();
  });

  it("summarises what the run used in one line", () => {
    expect(summaryLine(runSummary(events))).toBe("1 search · read 1 page · 1 couldn't load");
    expect(summaryLine(runSummary([]))).toBe("");
  });

  it("names the live phase from the newest unfinished step", () => {
    expect(runPhase("running", events)).toMatchObject({
      label: "Reading",
      detail: "notes.example",
      kind: "working",
    });
    expect(runPhase("running", events.slice(0, 5))).toMatchObject({
      label: "Thinking about what it found",
    });
    expect(runPhase("queued", [])).toMatchObject({ kind: "queued" });
    expect(
      runPhase("waiting", [
        ev("run.waiting", { reason: "model_capacity", until: "2026-10-02T12:01:00Z" }),
      ]),
    ).toMatchObject({ kind: "waiting", until: "2026-10-02T12:01:00Z" });
  });

  it("reads the latest plan", () => {
    const plan = runPlan([
      call("p0", "todo.write", { items: [{ text: "Search", done: false }] }),
      call("p1", "todo.write", { items: [{ text: "Search", done: true }, { text: "Write" }] }),
    ]);
    expect(plan).toEqual([
      { text: "Search", done: true },
      { text: "Write", done: false },
    ]);
  });
});
