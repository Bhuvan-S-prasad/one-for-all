import {
  asId,
  type AgentGrantRule,
  type AgentProfile,
  type RunContext,
  type ToolDescriptor,
} from "@ofa/core";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, grantFor } from "./index";

const ctx: RunContext = {
  workspaceId: asId("ws"),
  userId: asId("u"),
  agentId: asId("a"),
  runId: asId("r"),
};

function engine(grants: AgentGrantRule[]) {
  const agent = { id: ctx.agentId, grants } as unknown as AgentProfile;
  return createPolicyEngine({ agents: { get: async () => agent } });
}

const tool = (name: string, annotations: ToolDescriptor["annotations"] = {}): ToolDescriptor => ({
  name,
  description: "",
  inputSchema: {},
  annotations,
  source: "builtin",
});

describe("policy engine", () => {
  it("denies tools that are not granted, or blocked", async () => {
    const e = engine([{ tool: "web.search", mode: "blocked" }]);
    expect(
      (await e.evaluate({ ctx, tool: tool("gmail.send"), args: {}, tainted: false })).verdict,
    ).toBe("deny");
    expect(
      (await e.evaluate({ ctx, tool: tool("web.search"), args: {}, tainted: false })).verdict,
    ).toBe("deny");
  });

  it("uses the grant's mode, with exact names beating app wildcards", async () => {
    const grants: AgentGrantRule[] = [
      { tool: "hubspot.*", mode: "approve" },
      { tool: "hubspot.search", mode: "auto" },
    ];
    expect(grantFor(grants, "hubspot.search")?.mode).toBe("auto");
    expect(grantFor(grants, "hubspot.update")?.mode).toBe("approve");
    expect(grantFor(grants, "remember")).toBeUndefined();
  });

  it("escalates outbound tools in a tainted run, and destructive tools always", async () => {
    const e = engine([
      { tool: "gmail.send", mode: "auto" },
      { tool: "files.delete", mode: "auto" },
    ]);
    const send = tool("gmail.send", { outbound: true });
    expect((await e.evaluate({ ctx, tool: send, args: {}, tainted: false })).verdict).toBe("auto");
    const tainted = await e.evaluate({ ctx, tool: send, args: {}, tainted: true });
    expect(tainted.verdict).toBe("approve");
    expect(tainted.reasons.join(" ")).toMatch(/untrusted/);
    const del = tool("files.delete", { destructive: true });
    expect((await e.evaluate({ ctx, tool: del, args: {}, tainted: false })).verdict).toBe(
      "approve",
    );
  });

  it("in a tainted run, opens only addresses the run was given", async () => {
    const e = engine([{ tool: "browser.*", mode: "auto" }]);
    const open = tool("browser.open", { readOnly: true, opensUrl: "url" });
    const knownUrls = new Set(["https://shop.example/orders/5512"]);
    const ask = (url: string, tainted = true) =>
      e.evaluate({ ctx, tool: open, args: { url }, tainted, knownUrls });
    // Given (however it is written): no question.
    expect((await ask("https://www.shop.example/orders/5512/#top")).verdict).toBe("auto");
    // Made up, with data in it: a person decides.
    const made = await ask("https://verify-orders.example/check?email=sam@example.com");
    expect(made.verdict).toBe("approve");
    expect(made.reasons.join(" ")).toMatch(/address/);
    // Before reading anything outside, any address is fine.
    expect((await ask("https://anything.example/", false)).verdict).toBe("auto");
  });
});
