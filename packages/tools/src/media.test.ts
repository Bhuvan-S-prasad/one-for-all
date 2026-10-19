import {
  asId,
  type AgentProfile,
  type ArtifactId,
  type ArtifactInput,
  type RunContext,
  type SpendLedger,
  type ToolCallRecord,
  type ToolCallStore,
} from "@ofa/core";
import { createPolicyEngine } from "@ofa/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createToolExecutor,
  createToolRegistry,
  defineTool,
  mediaLinks,
  nameFor,
  saveFileTool,
  typeFor,
  type SafeDownload,
  type ToolDefinition,
  type ToolRunContext,
} from "./index";

// Keeping media (EN.13) and paid app credits (EN.15).

const ctx: RunContext = {
  workspaceId: asId("ws"),
  userId: asId("u"),
  agentId: asId("agent-a"),
  runId: asId("run-1"),
};

describe("files from the web", () => {
  it("finds links to pictures, video and sound by their path, once each", () => {
    const text =
      "Done: https://cdn.example/out/clip.mp4. Preview https://cdn.example/a.PNG and (https://cdn.example/a.PNG), page https://example.com/watch?v=1, http://plain.example/x.jpg";
    expect(mediaLinks(text)).toEqual([
      "https://cdn.example/out/clip.mp4",
      "https://cdn.example/a.PNG",
    ]);
  });

  it("takes the server's type unless it is vague, and names files sensibly", () => {
    expect(typeFor("https://x.example/a.mp4", "video/webm")).toBe("video/webm");
    expect(typeFor("https://x.example/a.mp4", "application/octet-stream")).toBe("video/mp4");
    expect(typeFor("https://x.example/a", "")).toBe("application/octet-stream");
    expect(nameFor("https://x.example/dir/My%20Clip.mp4", "video/mp4")).toBe("My Clip.mp4");
    expect(nameFor("https://x.example/render/123", "image/png")).toBe("123.png");
    expect(nameFor("https://x.example/", "image/png", "picture")).toBe("picture.png");
  });

  it("web.save_file keeps the download as the run's file, shown under the reply", async () => {
    const bytes = new TextEncoder().encode("PNGDATA");
    const download = async (url: string): Promise<SafeDownload> => ({
      url,
      contentType: "image/png",
      size: bytes.length,
      body: (async function* () {
        yield bytes;
      })(),
    });
    const kept: ArtifactInput[] = [];
    const runCtx = {
      ...ctx,
      toolCallId: "t1",
      idempotencyKey: "run-1:t1",
      artifacts: {
        async put(input: ArtifactInput) {
          kept.push(input);
          return {
            id: asId<ArtifactId>("00000000-0000-4000-8000-000000000001"),
            runId: ctx.runId,
            agentId: ctx.agentId,
            kind: input.kind,
            name: input.name,
            mimeType: input.mimeType,
            size: bytes.length,
            untrusted: input.untrusted,
            createdAt: new Date(),
          };
        },
        get: async () => null,
        read: async () => null,
      },
    } as unknown as ToolRunContext;
    const tool = saveFileTool(download as never);
    const out = await tool.run({ url: "https://cdn.example/shots/hero.png" }, runCtx);
    expect(out).toMatchObject({
      artifactId: "00000000-0000-4000-8000-000000000001",
      untrusted: false,
    });
    expect(String(out.content)).toContain("Saved hero.png (image/png, 7 bytes)");
    expect(kept[0]).toMatchObject({
      key: "run-1:t1:save",
      kind: "file",
      name: "hero.png",
      mimeType: "image/png",
      untrusted: true,
    });
  });
});

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

describe("paid app credits", () => {
  function setup(capCents: number | null) {
    const agent = {
      id: ctx.agentId,
      grants: [{ tool: "studio.*", mode: "auto" }],
      memoryScopes: [],
    } as unknown as AgentProfile;
    const agents = { get: async () => agent };
    const ledger: { key: string; costCents: number }[] = [];
    const spend: SpendLedger = {
      async month() {
        return { spentCents: ledger.reduce((s, e) => s + e.costCents, 0), capCents };
      },
      async record(_c, entry) {
        if (!ledger.some((e) => e.key === entry.idempotencyKey)) {
          ledger.push({ key: entry.idempotencyKey, costCents: entry.costCents });
        }
      },
    };
    let ran = 0;
    const render = defineTool({
      name: "studio.render",
      description: "Make a clip",
      input: z.object({}),
      annotations: { costUsd: 0.75, idempotent: true },
      async run() {
        ran += 1;
        return { content: "Rendering", untrusted: true };
      },
    });
    const executor = createToolExecutor({
      registry: createToolRegistry([render] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: calls(),
      agents,
      spend,
    });
    const call = (key: string, approved = true) => ({
      name: "studio.render",
      args: {},
      toolCallId: key,
      idempotencyKey: key,
      tainted: false,
      approved,
    });
    return { executor, ledger, call, ran: () => ran };
  }

  it("asks first, then counts the estimate once per call", async () => {
    const { executor, ledger, call, ran } = setup(null);
    expect(await executor.execute(call("run-1:t1", false), ctx)).toMatchObject({
      status: "blocked",
      verdict: "approve",
    });
    expect(ledger).toEqual([]);
    expect(await executor.execute(call("run-1:t1"), ctx)).toMatchObject({ status: "ok" });
    expect(await executor.execute(call("run-1:t1"), ctx)).toMatchObject({ status: "ok" });
    expect(ledger).toEqual([{ key: "run-1:t1", costCents: 75 }]);
    expect(ran()).toBe(1);
  });

  it("refuses a call that would pass the monthly limit, before anyone is asked", async () => {
    const { executor, ledger, call, ran } = setup(100);
    expect(await executor.execute(call("run-1:t1"), ctx)).toMatchObject({ status: "ok" });
    const refused = await executor.execute(call("run-1:t2", false), ctx);
    expect(refused).toMatchObject({ status: "blocked", verdict: "deny" });
    expect(refused.status === "blocked" && refused.message).toContain(
      "limit for paid app credits is $1.00, and $0.75 is used",
    );
    expect(await executor.execute(call("run-1:t2"), ctx)).toMatchObject({ verdict: "deny" });
    expect(ledger).toHaveLength(1);
    expect(ran()).toBe(1);
  });
});
