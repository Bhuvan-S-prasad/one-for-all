import { describe, expect, it } from "vitest";
import { skillReferences, skillSlug } from "./index";

describe("skill references (M5.08)", () => {
  it("finds /names written as words of their own", () => {
    expect(skillReferences("/morning-brief for today, please")).toEqual(["morning-brief"]);
    expect(skillReferences("Run /Weekly-Report then /tidy.")).toEqual(["weekly-report", "tidy"]);
  });

  it("ignores addresses and paths", () => {
    expect(skillReferences("see https://example.com/morning-brief")).toEqual([]);
    expect(skillReferences("open docs/morning-brief.md")).toEqual([]);
    expect(skillReferences("a/b")).toEqual([]);
  });
});

describe("skillSlug", () => {
  it("makes a handle from a name", () => {
    expect(skillSlug("Morning pipeline review")).toBe("morning-pipeline-review");
    expect(skillSlug("  Café – weekly   wrap-up! ")).toBe("cafe-weekly-wrap-up");
    expect(skillSlug("X")).toBe("skill-x");
    expect(skillSlug("a".repeat(80))).toHaveLength(60);
  });
});
