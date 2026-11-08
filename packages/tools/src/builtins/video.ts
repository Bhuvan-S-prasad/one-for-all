import { randomUUID } from "node:crypto";
import type { AgentId, RunContext, SandboxHandle, SandboxProvider } from "@ofa/core";
import {
  createVideoEngine,
  quoteArg,
  quoteCommand,
  VideoError,
  videoTools,
  type Runner,
} from "@ofa/video";
import type { z } from "zod";
import { defineTool, type ToolDefinition } from "../define";
import { computer } from "./computer";

// The video engine in One-for-All (ADR-0049): its tools as `video.*`, run in
// the agent's own computer through its sandbox handle, with grants, policy
// and the run log like any tool. The engine knows nothing of this; this file
// is the whole adapter.

/** Commands this short run in one request; longer ones run detached and are polled. */
const SHORT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The engine's commands in the agent's computer. A long command (a render, a
 * transcription) starts in the background with its output in files, and is
 * checked with short requests until it finishes, so no request outlives the
 * sandbox's or the HTTP client's time limits.
 */
export function sandboxRunner(handle: SandboxHandle, agentId: AgentId): Runner {
  const short = (command: string, timeoutMs = SHORT_MS) =>
    handle.exec(agentId, command, { timeoutMs });
  return {
    async run(argv, options = {}) {
      const timeoutMs = options.timeoutMs ?? SHORT_MS;
      if (timeoutMs <= SHORT_MS) {
        const r = await short(quoteCommand(argv), timeoutMs);
        return { code: r.timedOut ? 124 : r.exitCode, stdout: r.stdout, stderr: r.stderr };
      }
      const job = `.ofa-video/jobs/${randomUUID()}`;
      const dir = `"$HOME"/${job}`;
      const script = `echo $$ >${dir}/pid; ${quoteCommand(argv)} >${dir}/out 2>${dir}/err; echo $? >${dir}/code`;
      const started = await short(
        `mkdir -p ${dir} && setsid sh -c ${quoteArg(script)} </dev/null >/dev/null 2>&1 &`,
      );
      if (started.exitCode !== 0) {
        return { code: started.exitCode, stdout: "", stderr: started.stderr };
      }
      const deadline = Date.now() + timeoutMs;
      let wait = 1_000;
      let code: number | null = null;
      while (Date.now() < deadline) {
        await sleep(wait);
        wait = Math.min(5_000, wait * 1.5);
        const done = await short(`cat ${dir}/code 2>/dev/null || true`);
        if (done.stdout.trim()) {
          code = Number(done.stdout.trim());
          break;
        }
      }
      const read = async (name: string) => {
        try {
          return new TextDecoder().decode(await handle.readFile(agentId, `~/${job}/${name}`));
        } catch {
          return "";
        }
      };
      if (code === null) {
        await short(`kill -KILL -- -"$(cat ${dir}/pid)" 2>/dev/null; true`);
      }
      const [stdout, stderr] = await Promise.all([read("out"), read("err")]);
      await short(`rm -rf -- ${dir}`);
      return code === null
        ? {
            code: 124,
            stdout,
            stderr: `${stderr}\nStopped after ${Math.round(timeoutMs / 1000)} s.`,
          }
        : { code, stdout, stderr };
    },
    writeFile: (path, content) => handle.writeFile(agentId, path, content),
    readFile: (path) => handle.readFile(agentId, path),
    async env(name) {
      const r = await short(`printenv ${quoteArg(name)} || true`);
      return r.stdout.trim() || undefined;
    },
  };
}

/** The definitions, for names, descriptions and schemas; runs make their own with the run's files. */
const SPECS = videoTools(async () => {
  throw new Error("Not in a run");
});

export function videoEditTools(
  sandbox: SandboxProvider | null,
  /** Whether the run's model can see images; contact sheets are shown to it only then. */
  vision?: (ctx: RunContext) => Promise<boolean>,
): ToolDefinition<unknown>[] {
  return SPECS.map(
    (spec) =>
      defineTool({
        name: `video.${spec.name}`,
        description:
          spec.name === "verify"
            ? `${spec.description} When it passes, the video is attached under your reply.`
            : spec.description,
        input: spec.input as z.ZodType<unknown>,
        // Everything stays in the agent's own computer; renders only add files.
        annotations: spec.readOnly ? { readOnly: true, idempotent: true } : { idempotent: true },
        timeoutMs: spec.timeoutMs + 60_000,
        async run(args, ctx) {
          const handle = await computer(sandbox, ctx);
          // Two threads: the computer is shared with the agents' browsers and desktops.
          const engine = createVideoEngine({
            runner: sandboxRunner(handle, ctx.agentId),
            threads: 2,
          });
          const tool = videoTools(async (path) =>
            new TextDecoder().decode(await handle.readFile(ctx.agentId, path)),
          ).find((t) => t.name === spec.name)!;
          let result;
          try {
            result = await tool.run(engine, args as never);
          } catch (error) {
            if (error instanceof VideoError || error instanceof Error) {
              throw Object.assign(new Error(error.message), {
                code:
                  error instanceof VideoError && error.code === "bad_input"
                    ? "invalid_args"
                    : "tool_failed",
              });
            }
            throw error;
          }
          const image =
            result.image && (await vision?.(ctx))
              ? {
                  data: Buffer.from(await handle.readFile(ctx.agentId, result.image)).toString(
                    "base64",
                  ),
                  mediaType: "image/jpeg" as const,
                }
              : undefined;
          // A render that passes its check is the deliverable: it goes under the
          // reply then, so delivery doesn't hang on the model remembering
          // files.send (a live run verified and stopped without sending).
          let content = result.text;
          let artifactId: string | undefined;
          if (spec.name === "verify" && result.text.startsWith("OK") && ctx.artifacts) {
            const path = (args as { output: string }).output;
            const name = path.split("/").pop() || path;
            const streamed = handle.readFileStream
              ? await handle.readFileStream(ctx.agentId, path)
              : null;
            const kept = await ctx.artifacts.put({
              key: `${ctx.idempotencyKey}:video`,
              kind: "file",
              name,
              mimeType: "video/mp4",
              content: streamed ?? (await handle.readFile(ctx.agentId, path)),
              untrusted: ctx.tainted,
            });
            artifactId = kept.id;
            content += `\nAttached ${name} under your reply; send other formats with files.send.`;
          }
          return {
            content,
            // File names and speech come from the footage: outside content.
            untrusted: spec.name !== "styles",
            ...(image ? { image } : {}),
            ...(artifactId ? { artifactId } : {}),
          };
        },
      }) as unknown as ToolDefinition<unknown>,
  );
}
