import { readFile } from "node:fs/promises";
import { createVideoEngine } from "./engine";
import { serveMcp } from "./mcp";
import { localRunner } from "./runner";
import { videoTools } from "./tools";

// The engine on its own (ADR-0049), on this machine:
//
//   ofa-video mcp                         serve the tools over MCP (stdio)
//   ofa-video <tool> '<json arguments>'   run one tool: scan, music, plan_beats, render…
//   ofa-video <tool> key=value …          the same, for simple arguments
//
// Needs ffmpeg, and Python with librosa (and faster-whisper to transcribe).

const runner = localRunner();
const engine = createVideoEngine({ runner });
const tools = videoTools(async (path) => readFile(path, "utf8"));

function parseArgs(rest: readonly string[]): Record<string, unknown> {
  if (rest.length === 1 && rest[0]!.trim().startsWith("{")) {
    return JSON.parse(rest[0]!) as Record<string, unknown>;
  }
  return Object.fromEntries(
    rest.map((pair) => {
      const at = pair.indexOf("=");
      if (at < 1) throw new Error(`Expected key=value, got ${pair}`);
      const value = pair.slice(at + 1);
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        // A plain string.
      }
      return [pair.slice(0, at), parsed];
    }),
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "mcp") {
    await serveMcp({ engine, tools, runner });
    return 0;
  }
  const tool = tools.find((t) => t.name === command);
  if (!tool) {
    process.stderr.write(
      `Usage: ofa-video mcp | ofa-video <tool> [json | key=value…]\nTools: ${tools.map((t) => t.name).join(", ")}\n`,
    );
    return command ? 2 : 0;
  }
  const parsed = tool.input.safeParse(parseArgs(rest));
  if (!parsed.success) {
    process.stderr.write(`${parsed.error.message}\n`);
    return 2;
  }
  const result = await tool.run(engine, parsed.data);
  process.stdout.write(`${result.text}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
