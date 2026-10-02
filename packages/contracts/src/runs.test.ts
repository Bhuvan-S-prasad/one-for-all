import { describe, expect, it } from "vitest";
import {
  EMPTY_RUN_USAGE,
  RUN_EVENT_TYPES,
  createThreadRequestSchema,
  runEventInputSchema,
  runEventSchema,
} from "./index";

describe("run events", () => {
  it("the union covers every declared event type", () => {
    const inUnion = runEventInputSchema.options.map((option) => option.shape.type.value);
    expect([...inUnion].sort()).toEqual([...RUN_EVENT_TYPES].sort());
  });

  it("parses a stored event and checks its payload by type", () => {
    const event = {
      id: "evt_1",
      runId: "run_1",
      seq: 3,
      createdAt: "2026-10-01T09:00:00.000Z",
      type: "run.ended",
      payload: { status: "succeeded", stopReason: "final_answer", usage: EMPTY_RUN_USAGE },
    };
    expect(runEventSchema.parse(event).type).toBe("run.ended");
    expect(
      runEventSchema.safeParse({ ...event, payload: { ...event.payload, stopReason: "bored" } })
        .success,
    ).toBe(false);
  });

  it("rejects unknown event types", () => {
    expect(runEventInputSchema.safeParse({ type: "run.exploded", payload: {} }).success).toBe(
      false,
    );
  });
});

describe("createThreadRequestSchema", () => {
  it("allows one to six distinct agents", () => {
    expect(createThreadRequestSchema.safeParse({ agentIds: ["a"] }).success).toBe(true);
    expect(createThreadRequestSchema.safeParse({ agentIds: [] }).success).toBe(false);
    expect(createThreadRequestSchema.safeParse({ agentIds: ["a", "a"] }).success).toBe(false);
    expect(
      createThreadRequestSchema.safeParse({ agentIds: ["1", "2", "3", "4", "5", "6", "7"] })
        .success,
    ).toBe(false);
  });
});
