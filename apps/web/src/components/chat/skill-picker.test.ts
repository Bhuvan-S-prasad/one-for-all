import type { Skill } from "@ofa/contracts";
import { describe, expect, it } from "vitest";
import { insertSkill, matchSkills, skillQuery } from "./skill-picker";

const skill = (slug: string, name: string, status: Skill["status"] = "active"): Skill => ({
  id: slug,
  agentId: null,
  slug,
  name,
  description: name,
  steps: ["a", "b"],
  status,
  source: "person",
  sourceRunId: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

describe("the / skill picker (M5.08)", () => {
  it("knows when a /name is being typed", () => {
    expect(skillQuery("/")).toBe("");
    expect(skillQuery("please run /Morn")).toBe("morn");
    expect(skillQuery("see https://x.com/a")).toBeNull();
    expect(skillQuery("/brief now")).toBeNull();
  });

  it("puts the chosen skill in place of what was typed", () => {
    expect(insertSkill("please run /mor", "morning-brief")).toBe("please run /morning-brief ");
  });

  it("offers active skills by handle or name", () => {
    const all = [
      skill("morning-brief", "Morning brief"),
      skill("weekly", "Weekly report"),
      skill("mopping", "Mop up", "proposed"),
    ];
    expect(matchSkills(all, "mo").map((s) => s.slug)).toEqual(["morning-brief"]);
    expect(matchSkills(all, "report").map((s) => s.slug)).toEqual(["weekly"]);
  });
});
