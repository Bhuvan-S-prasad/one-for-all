import {
  asId,
  type AgentProfile,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactStore,
  type RunContext,
  type ToolCallRecord,
  type ToolCallStore,
} from "@ofa/core";
import { createPolicyEngine } from "@ofa/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactsReadTool,
  createToolExecutor,
  createToolRegistry,
  defineTool,
  type ToolDefinition,
} from "./index";

// Long output becomes an artifact the agent reopens (M3.06).

const ctx: RunContext = {
  workspaceId: asId("ws"),
  userId: asId("u"),
  agentId: asId("agent-a"),
  runId: asId("run-1"),
};

function memoryArtifacts(): ArtifactStore & { rows: Map<string, ArtifactRecord & { content: Uint8Array }> } {
  const rows = new Map<string, ArtifactRecord & { content: Uint8Array }>();
  let n = 0;
  return {
    rows,
    async put(c, input) {
      const existing = [...rows.values()].find((r) => r.runId === c.runId && r.name === `${input.key}`);
      if (existing) return existing;
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      const content = new TextEncoder().encode(String(input.content));
      const row = {
        id: asId<ArtifactId>(id),
        runId: c.runId,
        agentId: c.agentId,
        kind: input.kind,
        name: input.name,
        mimeType: input.mimeType,
        size: content.length,
        untrusted: input.untrusted,
        createdAt: new Date(),
        content,
      };
      rows.set(id, row);
      return row;
    },
    async get(_c, id) {
      return rows.get(id) ?? null;
    },
    async read(_c, id) {
      return rows.get(id)?.content ?? null;
    },
    async listForRun(_c, runId) {
      return [...rows.values()].filter((r) => r.runId === runId);
    },
  };
}

function calls(): ToolCallStore {
  const rows = new Map<string, ToolCallRecord>();
  return {
    async begin(_c, input) {
      const existing = rows.get(input.idempotencyKey);
      if (existing) return { created: false, existing };
      rows.set(input.idempotencyKey, { status: "in_flight", result: null, untrusted: false });
      return { created: true };
    },
    async complete(_c, key, outcome) {
      rows.set(key, { status: "done", result: outcome.result, untrusted: outcome.untrusted });
    },
    async fail(_c, key) {
      rows.set(key, { status: "failed", result: null, untrusted: false });
    },
  };
}

const long = defineTool({
  name: "test.long",
  description: "Long output",
  input: z.object({}),
  annotations: { readOnly: true },
  async run() {
    return { content: `start ${"x".repeat(20_000)} end`, untrusted: true };
  },
});

function setup(grants: AgentProfile["grants"] = [{ tool: "test.long", mode: "auto" }]) {
  const agent: AgentProfile = {
    id: ctx.agentId,
    slug: "a",
    name: "A",
    description: "",
    status: "active",
    job: "x",
    modelTier: "fast",
    autonomy: "act-with-approval",
    voice: "calm",
    memoryScopes: [],
    budgets: { steps: 5, tokens: 10_000 },
    grants,
  };
  const agents = { get: async () => agent };
  const artifacts = memoryArtifacts();
  const executor = createToolExecutor({
    registry: createToolRegistry([long, artifactsReadTool()] as unknown as ToolDefinition<never>[]),
    policy: createPolicyEngine({ agents }),
    calls: calls(),
    agents,
    artifacts,
    maxResultChars: 8_000,
  });
  return { executor, artifacts };
}

const call = (name: string, args: unknown, key: string) => ({
  name,
  args,
  toolCallId: key,
  idempotencyKey: key,
  tainted: false,
});

describe("artifacts", () => {
  it("keeps long output whole and gives the model its start and a handle", async () => {
    const { executor, artifacts } = setup();
    const outcome = await executor.execute(call("test.long", {}, "run-1:t1"), ctx);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.content.length).toBeLessThan(8_200);
    expect(outcome.content).toMatch(/saved as artifact:\/\/[0-9a-f-]{36}; read on with artifacts\.read and from: 7700/);
    expect(outcome.artifactId).toBeDefined();
    const saved = artifacts.rows.get(outcome.artifactId!);
    expect(saved).toMatchObject({ kind: "output", name: "test.long output", untrusted: true });
    expect(new TextDecoder().decode(saved!.content).endsWith(" end")).toBe(true);
  });

  it("lets every agent reopen its own artifacts, without a grant", async () => {
    const { executor } = setup();
    expect((await executor.listTools(ctx)).map((t) => t.name)).toContain("artifacts.read");
    const first = await executor.execute(call("test.long", {}, "run-1:t1"), ctx);
    const uri = first.status === "ok" ? `artifact://${first.artifactId}` : "";
    const read = await executor.execute(call("artifacts.read", { uri, from: 19_000 }, "run-1:t2"), ctx);
    expect(read).toMatchObject({ status: "ok", untrusted: true });
    expect(read.status === "ok" && read.content).toContain("x end");
  });

  it("doesn't let an agent read another agent's artifacts", async () => {
    const { executor, artifacts } = setup();
    const theirs = await artifacts.put(
      { ...ctx, agentId: asId("agent-b") },
      { key: "k", kind: "output", name: "secret", mimeType: "text/plain", content: "theirs", untrusted: false },
    );
    const read = await executor.execute(
      call("artifacts.read", { uri: `artifact://${theirs.id}`, from: 0 }, "run-1:t3"),
      ctx,
    );
    expect(read).toMatchObject({ status: "error", code: "not_found" });
  });

  it("can still be blocked by a grant", async () => {
    const { executor } = setup([
      { tool: "test.long", mode: "auto" },
      { tool: "artifacts.read", mode: "blocked" },
    ]);
    expect((await executor.listTools(ctx)).map((t) => t.name)).not.toContain("artifacts.read");
  });
});
