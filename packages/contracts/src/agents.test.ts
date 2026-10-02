import { describe, expect, it } from "vitest";
import {
  createAgentRequestSchema,
  toAgentSlug,
  toolPatternSchema,
  updateAgentRequestSchema,
  type AgentSpecInput,
} from "./index";

const spec: AgentSpecInput = {
  job: "Research",
  avatar: { form: "bloom", eyes: "googly", skin: "dots", color: "lilac", mark: "spark" },
};

describe("createAgentRequestSchema", () => {
  it("fills spec defaults", () => {
    const parsed = createAgentRequestSchema.parse({ name: "Researcher", spec });
    expect(parsed.spec).toMatchObject({
      modelTier: "standard",
      autonomy: "act-with-approval",
      voice: "calm",
      memoryScopes: ["agent", "workspace"],
      budgets: { steps: 40, tokens: 120_000 },
    });
    expect(parsed.grants).toEqual([]);
    expect(parsed.description).toBe("");
  });

  it("rejects duplicate grants and duplicate memory scopes", () => {
    const grants = [
      { tool: "web.search", mode: "auto" },
      { tool: "web.search", mode: "approve" },
    ];
    expect(createAgentRequestSchema.safeParse({ name: "R", spec, grants }).success).toBe(false);
    const scopes = { ...spec, memoryScopes: ["agent", "agent"] };
    expect(createAgentRequestSchema.safeParse({ name: "R", spec: scopes }).success).toBe(false);
  });

  it("rejects an unknown voice and a missing familiar", () => {
    expect(
      createAgentRequestSchema.safeParse({ name: "R", spec: { ...spec, voice: "sarcastic" } })
        .success,
    ).toBe(false);
    expect(createAgentRequestSchema.safeParse({ name: "R", spec: { job: "x" } }).success).toBe(
      false,
    );
  });
});

describe("updateAgentRequestSchema", () => {
  it("needs at least one field", () => {
    expect(updateAgentRequestSchema.safeParse({}).success).toBe(false);
    expect(updateAgentRequestSchema.safeParse({ status: "paused" }).success).toBe(true);
  });
});

describe("toolPatternSchema", () => {
  it("accepts tool names and app wildcards", () => {
    for (const tool of ["web.search", "gmail.create_draft", "hubspot.*", "remember"]) {
      expect(toolPatternSchema.safeParse(tool).success, tool).toBe(true);
    }
  });

  it("rejects other shapes", () => {
    for (const tool of ["*", "Web.search", "gmail.createDraft", "a.b.c", "web."]) {
      expect(toolPatternSchema.safeParse(tool).success, tool).toBe(false);
    }
  });
});

describe("toAgentSlug", () => {
  it("makes mention-friendly slugs", () => {
    expect(toAgentSlug("Inbox Assistant")).toBe("inbox-assistant");
    expect(toAgentSlug("  Café Scout! ")).toBe("cafe-scout");
    expect(toAgentSlug("???")).toBe("agent");
    expect(toAgentSlug("a".repeat(40))).toHaveLength(32);
  });
});
