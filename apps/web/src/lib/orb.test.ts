import { describe, expect, it } from "vitest";
import { orbStateFor } from "./orb";
import { runPhase } from "./run-steps";

// Which thinking orb a run's phase shows.

describe("orbStateFor", () => {
  it("picks the verb the run is doing", () => {
    expect(orbStateFor({ kind: "queued" })).toBe("connecting");
    expect(orbStateFor({ kind: "thinking" })).toBe("solving");
    expect(orbStateFor({ kind: "thinking", after: "tools" })).toBe("weaving");
    expect(orbStateFor({ kind: "thinking", after: "compaction" })).toBe("shaping");
    expect(orbStateFor({ kind: "waiting", waitingFor: "you" })).toBe("listening");
    expect(orbStateFor({ kind: "waiting", waitingFor: "model" })).toBe("breathing");
  });

  it("matches tools to what they look like from outside, and hands-on work by default", () => {
    expect(orbStateFor({ kind: "working", tool: "web.search" })).toBe("searching");
    expect(orbStateFor({ kind: "working", tool: "web.read_url" })).toBe("listening");
    expect(orbStateFor({ kind: "working", tool: "files.write" })).toBe("composing");
    expect(orbStateFor({ kind: "working", tool: "delegate_task" })).toBe("weaving");
    expect(orbStateFor({ kind: "working", tool: "browser.click" })).toBe("working");
    expect(orbStateFor({ kind: "working", tool: "notion.create_page" })).toBe("working");
  });

  it("reads the tool from a live run's phase", () => {
    const phase = runPhase("running", [
      {
        id: "e1",
        runId: "r1",
        seq: 1,
        type: "tool.called",
        createdAt: "2026-11-08T10:00:00.000Z",
        payload: { toolCallId: "t1", tool: "web.search", args: { query: "pgvector" } },
      } as never,
    ]);
    expect(phase.tool).toBe("web.search");
    expect(orbStateFor(phase)).toBe("searching");
  });
});
