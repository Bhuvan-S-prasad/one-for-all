import { describe, expect, it } from "vitest";
import {
  groupName,
  isWorkspacePath,
  plainText,
  rowPreview,
  rowState,
  rowTime,
} from "./conversations";

// The sidebar's rows (ADR-0052).

const agents = new Map([
  ["a1", { name: "Chief" }],
  ["a2", { name: "Scout" }],
]);
const last = (
  snippet: string,
  author: "user" | "agent" = "agent",
  agentId: string | null = "a1",
) => ({
  snippet,
  author,
  agentId,
  at: "2026-11-08T08:29:00.000Z",
});

describe("rowState", () => {
  it("shows the most urgent state only: action needed, then stuck, then unread", () => {
    expect(rowState({ needsYou: 1, stuck: true, unread: 3 })).toBe("action");
    expect(rowState({ needsYou: 0, stuck: true, unread: 3 })).toBe("stuck");
    expect(rowState({ needsYou: 0, stuck: false, unread: 3 })).toBe("unread");
    expect(rowState({ needsYou: 0, stuck: false, unread: 0 })).toBeNull();
  });
});

describe("rowTime", () => {
  const now = new Date(2026, 10, 8, 15, 0);
  it("says the time today, Yesterday, a weekday this week, then a date", () => {
    expect(rowTime(new Date(2026, 10, 8, 8, 29).toISOString(), now)).toMatch(/08:29|8:29/);
    expect(rowTime(new Date(2026, 10, 7, 23, 0).toISOString(), now)).toBe("Yesterday");
    expect(rowTime(new Date(2026, 10, 4, 9, 0).toISOString(), now)).not.toMatch(/\d{4}/);
    expect(rowTime(new Date(2025, 9, 12).toISOString(), now)).toMatch(/2025/);
  });
});

describe("rowPreview", () => {
  it("strips Markdown and says who wrote it", () => {
    expect(plainText("**Booked** the [venue](https://x.example) and sent `the contract`")).toBe(
      "Booked the venue and sent the contract",
    );
    expect(
      rowPreview(
        { kind: "direct", last: last("## Done\n- one"), stuck: false, needsYou: 0 },
        agents,
      ),
    ).toBe("Done one");
    expect(
      rowPreview(
        { kind: "direct", last: last("Hi there", "user", null), stuck: false, needsYou: 0 },
        agents,
      ),
    ).toBe("You: Hi there");
    expect(
      rowPreview(
        { kind: "group", last: last("On it", "agent", "a2"), stuck: false, needsYou: 0 },
        agents,
      ),
    ).toBe("Scout: On it");
    expect(rowPreview({ kind: "direct", last: null, stuck: false, needsYou: 0 }, agents)).toBe(
      "Say hello",
    );
  });

  it("names a group by its title, else its agents", () => {
    expect(groupName({ title: "Offsite crew", agentIds: ["a1"] }, agents)).toBe("Offsite crew");
    expect(groupName({ title: null, agentIds: ["a1", "a2"] }, agents)).toBe("Chief, Scout");
  });
});

describe("isWorkspacePath", () => {
  it("knows the workspace's pages from a conversation's", () => {
    for (const p of [
      "/overview",
      "/agents",
      "/agents/new",
      "/activity",
      "/approvals",
      "/routines",
      "/skills/",
      "/settings",
    ]) {
      expect(isWorkspacePath(p)).toBe(true);
    }
    for (const p of ["/", "/agents/abc", "/agents/abc/history", "/groups/xyz", "/groups/new"]) {
      expect(isWorkspacePath(p)).toBe(false);
    }
  });
});
