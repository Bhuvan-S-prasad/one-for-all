import type { Message, Run, RunEvent } from "@ofa/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyRealtime, moodFor, queryKeys } from "./index";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function run(patch: Partial<Run> = {}): Run {
  return {
    id: "r1",
    agentId: "a1",
    threadId: "t1",
    parentRunId: null,
    trigger: "message",
    status: "running",
    tainted: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
    error: null,
    createdAt: "2026-10-02T11:59:00Z",
    startedAt: "2026-10-02T11:59:01Z",
    endedAt: null,
    ...patch,
  };
}

const event = (seq: number, type: RunEvent["type"] = "run.resumed"): RunEvent =>
  ({
    id: `e${seq}`,
    runId: "r1",
    seq,
    createdAt: "2026-10-02T12:00:00Z",
    type,
    payload: {},
  }) as RunEvent;

describe("moodFor", () => {
  it("follows the latest run", () => {
    expect(moodFor({ agentStatus: "active", now: NOW })).toBe("idle");
    expect(moodFor({ agentStatus: "paused", run: run(), now: NOW })).toBe("asleep");
    expect(moodFor({ agentStatus: "active", run: run({ status: "queued" }), now: NOW })).toBe(
      "thinking",
    );
    expect(
      moodFor({ agentStatus: "active", run: run(), lastEvent: event(3, "tool.called"), now: NOW }),
    ).toBe("working");
    expect(moodFor({ agentStatus: "active", run: run({ status: "waiting" }), now: NOW })).toBe(
      "waiting",
    );
  });

  it("shows an error for a while, then recovers; naps after a long quiet spell", () => {
    const failed = (endedAt: string) => run({ status: "failed", endedAt });
    expect(moodFor({ agentStatus: "active", run: failed("2026-10-02T11:50:00Z"), now: NOW })).toBe(
      "error",
    );
    expect(moodFor({ agentStatus: "active", run: failed("2026-10-02T10:00:00Z"), now: NOW })).toBe(
      "idle",
    );
    const old = run({ status: "succeeded", endedAt: "2026-10-01T12:00:00Z" });
    expect(moodFor({ agentStatus: "active", run: old, now: NOW })).toBe("asleep");
  });
});

describe("applyRealtime", () => {
  it("keeps run events in seq order and drops duplicates", () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.runEvents("r1"), [event(0)]);
    applyRealtime(qc, { type: "run.event", event: event(2) });
    applyRealtime(qc, { type: "run.event", event: event(1) });
    applyRealtime(qc, { type: "run.event", event: event(1) });
    expect(qc.getQueryData<RunEvent[]>(queryKeys.runEvents("r1"))?.map((e) => e.seq)).toEqual([
      0, 1, 2,
    ]);
  });

  it("updates a run everywhere it is cached", () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.runs(), [run()]);
    qc.setQueryData(queryKeys.runs("a1"), [run()]);
    applyRealtime(qc, { type: "run.updated", run: run({ status: "succeeded" }) });
    expect(qc.getQueryData<Run>(queryKeys.run("r1"))?.status).toBe("succeeded");
    expect(qc.getQueryData<Run[]>(queryKeys.runs())?.[0]?.status).toBe("succeeded");
    expect(qc.getQueryData<Run[]>(queryKeys.runs("a1"))?.[0]?.status).toBe("succeeded");
  });

  it("appends new messages to an open thread once", () => {
    const qc = new QueryClient();
    const message: Message = {
      id: "m2",
      threadId: "t1",
      author: { type: "agent", agentId: "a1" },
      content: "Hi",
      runId: "r1",
      createdAt: "2026-10-02T12:00:01Z",
    };
    qc.setQueryData(queryKeys.messages("t1"), []);
    applyRealtime(qc, { type: "message.created", message });
    applyRealtime(qc, { type: "message.created", message });
    expect(qc.getQueryData<Message[]>(queryKeys.messages("t1"))).toHaveLength(1);
  });
});
