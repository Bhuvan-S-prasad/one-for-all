import type { Discussion, DiscussionTurnRecord, Message } from "@ofa/contracts";
import { describe, expect, it } from "vitest";
import { discussionRoles, foldLabel, foldTurns, pinnedAnswer, progressOf } from "./discussions";

// Group discussions in the chat (ADR-0050): whose turn it is, the turns folded
// once it closed, and the answer pinned.

const turn = (
  agentId: string,
  round: number,
  position: number | null,
  status: DiscussionTurnRecord["status"],
  messageId: string | null,
): DiscussionTurnRecord => ({
  runId: `run-${agentId}-${round}-${position}`,
  agentId,
  round,
  position,
  close: position === null,
  status,
  messageId,
});

const discussion = (patch: Partial<Discussion>): Discussion => ({
  id: "d1",
  threadId: "t1",
  questionMessageId: "q",
  coordinatorAgentId: "lead",
  memberIds: ["ana", "ben"],
  rounds: 2,
  round: 1,
  status: "active",
  closingMessageId: null,
  tainted: false,
  createdAt: "2026-10-20T10:00:00.000Z",
  endedAt: null,
  turns: [],
  ...patch,
});

const message = (id: string, agentId: string | null): Message => ({
  id,
  threadId: "t1",
  author: agentId ? { type: "agent", agentId } : { type: "user", userId: "u" },
  content: id,
  runId: null,
  createdAt: "2026-10-20T10:00:00.000Z",
});

describe("progressOf", () => {
  it("says whose turn it is, who answered and who waits", () => {
    const d = discussion({
      turns: [turn("ana", 1, 0, "succeeded", "a1"), turn("ben", 1, 1, "running", null)],
    });
    expect(progressOf(d)).toEqual({
      round: 1,
      members: [
        { agentId: "ana", state: "answered" },
        { agentId: "ben", state: "speaking" },
      ],
      current: "ben",
      closing: "waiting",
    });
  });

  it("counts a pass and a failed turn in the round, and the coordinator writing", () => {
    const d = discussion({
      round: 2,
      status: "closing",
      turns: [
        turn("ana", 1, 0, "succeeded", "a1"),
        turn("ben", 1, 1, "succeeded", "b1"),
        turn("ana", 2, 0, "succeeded", null),
        turn("ben", 2, 1, "failed", null),
        turn("lead", 2, null, "running", null),
      ],
    });
    const progress = progressOf(d);
    expect(progress.members.map((m) => m.state)).toEqual(["passed", "skipped"]);
    expect(progress).toMatchObject({ round: 2, current: "lead", closing: "writing" });
  });
});

describe("foldTurns", () => {
  const messages = [
    message("q", null),
    message("a1", "ana"),
    message("b1", "ben"),
    message("note", null),
    message("a2", "ana"),
    message("close", "lead"),
  ];
  const turns = [
    turn("ana", 1, 0, "succeeded", "a1"),
    turn("ben", 1, 1, "succeeded", "b1"),
    turn("ana", 2, 0, "succeeded", "a2"),
    turn("lead", 2, null, "succeeded", "close"),
  ];

  it("folds an ended discussion's turns, keeping the question, the answer and the person's words", () => {
    const done = discussion({ status: "done", round: 2, closingMessageId: "close", turns });
    const items = foldTurns(messages, discussionRoles([done]));
    expect(
      items.map((i) => (i.kind === "turns" ? i.messages.map((m) => m.id) : i.message.id)),
    ).toEqual(["q", ["a1", "b1"], "note", ["a2"], "close"]);
    expect(discussionRoles([done]).get("close")?.role).toBe("close");
  });

  it("leaves an open discussion's turns showing as they come", () => {
    const open = discussion({ turns: turns.slice(0, 2) });
    expect(foldTurns(messages, discussionRoles([open])).every((i) => i.kind === "message")).toBe(
      true,
    );
  });

  it("names the fold by messages and agents", () => {
    expect(foldLabel([message("a1", "ana"), message("b1", "ben"), message("a2", "ana")])).toBe(
      "3 messages with 2 agents",
    );
    expect(foldLabel([message("a1", "ana")])).toBe("1 message with 1 agent");
  });
});

describe("pinnedAnswer", () => {
  it("pins the latest discussion that closed with an answer", () => {
    const older = discussion({ id: "old", status: "done", closingMessageId: "c0" });
    const newer = discussion({
      id: "new",
      status: "done",
      closingMessageId: "c1",
      createdAt: "2026-10-20T11:00:00.000Z",
    });
    const stopped = discussion({
      id: "stopped",
      status: "stopped",
      createdAt: "2026-10-20T12:00:00.000Z",
    });
    expect(pinnedAnswer([older, newer, stopped])?.id).toBe("new");
    expect(pinnedAnswer([stopped])).toBeNull();
  });
});
