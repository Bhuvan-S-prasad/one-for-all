import { asId, type RunContext } from "@ofa/core";
import { createDockerSandbox } from "@ofa/sandbox";
import { videoEditTools, type ToolDefinition } from "@ofa/tools";
import { beforeAll, describe, expect, it } from "vitest";

// The video tools through the real dev sandbox (EN.17, ADR-0049): commands
// run as the agent, long ones detached and polled, files in its own home.
// Needs `pnpm infra:up`.

const sandbox = createDockerSandbox({
  url: process.env.SANDBOX_URL || "http://127.0.0.1:7070",
  token: process.env.SANDBOX_TOKEN || "ofa-sandbox-dev-token",
});
const ctx: RunContext = {
  workspaceId: asId("ws_eval"),
  userId: asId("usr_eval"),
  agentId: asId("eval-video"),
  runId: asId("run_eval"),
};
const tools = new Map(videoEditTools(sandbox).map((t) => [t.name, t as ToolDefinition<unknown>]));
/** What the tools kept under the reply, with how many bytes each held. */
const kept: { name: string; mimeType: string; bytes: number }[] = [];
const artifacts = {
  async put(input: { name: string; mimeType: string; content: unknown }) {
    let bytes = 0;
    const c = input.content as Uint8Array | { body: AsyncIterable<Uint8Array> };
    if (c instanceof Uint8Array) bytes = c.length;
    else for await (const part of c.body) bytes += part.length;
    kept.push({ name: input.name, mimeType: input.mimeType, bytes });
    return { id: `art-${kept.length}`, name: input.name };
  },
  get: async () => null,
  read: async () => null,
};
const run = async (name: string, args: unknown) => {
  const tool = tools.get(name)!;
  return tool.run(tool.input.parse(args), {
    ...ctx,
    idempotencyKey: `run_eval:${name}`,
    tainted: false,
    memoryScopes: ["agent"],
    artifacts,
  } as never);
};

beforeAll(async () => {
  const handle = await sandbox.acquire(ctx);
  const made = await handle.exec(
    ctx.agentId,
    "rm -rf ~/clips ~/.ofa-video && mkdir -p ~/clips && cd ~/clips && ffmpeg -v error -f lavfi -i testsrc2=s=640x360:r=30:d=6 -f lavfi -i sine=f=440:d=6 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac a.mp4",
    { timeoutMs: 120_000 },
  );
  expect(made.stderr).toBe("");
  expect(made.exitCode).toBe(0);
}, 180_000);

describe("video tools in the agent's computer", () => {
  it("are all there, each as video.<name>", () => {
    expect([...tools.keys()]).toEqual([
      "video.scan",
      "video.music",
      "video.transcribe",
      "video.plan_beats",
      "video.render",
      "video.verify",
      "video.contact_sheet",
      "video.styles",
    ]);
    expect(tools.get("video.render")!.annotations.readOnly).toBeUndefined();
    expect(tools.get("video.scan")!.annotations.readOnly).toBe(true);
  });

  it("scans, renders in the background, verifies, and keeps renders out of the sources", async () => {
    const scan = await run("video.scan", { path: "~/clips/a.mp4" });
    expect(scan.content).toMatch(/640×360, 30 fps, 6\.\d+ s, sound: yes/);
    expect(scan.untrusted).toBe(true);

    const timeline = {
      version: 1,
      output: { width: 360, height: 640, fps: 30 },
      clips: [
        {
          src: "~/clips/a.mp4",
          from: 0,
          frames: 45,
          audio: 0,
          effects: [{ type: "zoom", frames: 6 }],
        },
        { src: "~/clips/a.mp4", from: 3, frames: 30, speed: 2, audio: -6 },
      ],
      grade: { preset: "warm" },
    };
    const rendered = await run("video.render", { timeline, output: "~/clips/out/edit.mp4" });
    expect(rendered.content).toMatch(
      /Rendered ~\/clips\/out\/edit\.mp4: 360×640, 30 fps, 75 frames/,
    );
    const verified = await run("video.verify", { timeline, output: "~/clips/out/edit.mp4" });
    expect(verified.content).toMatch(/^OK: no problems\./);
    // A render that passes its check goes under the reply by itself.
    expect(verified.artifactId).toBe("art-1");
    expect(kept).toEqual([{ name: "edit.mp4", mimeType: "video/mp4", bytes: expect.any(Number) }]);
    expect(kept[0]!.bytes).toBeGreaterThan(10_000);

    await expect(run("video.render", { timeline, output: "~/clips/a.mp4" })).rejects.toMatchObject({
      code: "invalid_args",
    });
  }, 600_000);
});
