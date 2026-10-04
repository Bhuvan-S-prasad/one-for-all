import { agentSpecSchema, type Agent } from "@ofa/contracts";
import { describe, expect, it } from "vitest";
import { parseMention, starters } from "./agents";

const agent = (name: string, slug: string, tools: string[] = []): Agent => ({
  id: slug,
  slug,
  name,
  description: "",
  status: "active",
  spec: agentSpecSchema.parse({
    job: "Research",
    avatar: { form: "blob", eyes: "googly", skin: "solid", color: "sand", mark: "none" },
  }),
  grants: tools.map((tool) => ({ tool, mode: "auto" as const })),
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

describe("parseMention", () => {
  const agents = [agent("Scout", "scout"), agent("Mail Room", "mail-room")];

  it("picks the agent by slug or name and keeps the rest", () => {
    expect(parseMention("@scout compare two tools", agents)).toMatchObject({
      agent: { slug: "scout" },
      rest: "compare two tools",
    });
    expect(parseMention("  @MAIL-ROOM hi", agents)?.agent.slug).toBe("mail-room");
  });

  it("ignores unknown names and text without a mention", () => {
    expect(parseMention("@nobody hello", agents)).toBeNull();
    expect(parseMention("email me @scout", agents)).toBeNull();
  });
});

describe("starters", () => {
  it("offers prompts that match the agent's tools", () => {
    expect(starters(agent("Scout", "scout", ["web.search", "remember"]))).toEqual([
      "Find the latest on something for me, with sources",
      "Remember that I prefer short answers",
      "What can you help me with?",
    ]);
    expect(starters(agent("Plain", "plain"))).toEqual(["What can you help me with?"]);
  });
});
