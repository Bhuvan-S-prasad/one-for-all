// Vision spike (DT.10): which free models read a screenshot of an agent's
// desktop well enough to act on it, and in which coordinates do they point?
// Three tasks per model on a real screenshot
// (evals/fixtures/desktop/desktop-apps.png, 1280×800: AbiWord in front,
// Gnumeric and the Agent terminal), asked once with pixel coordinates and
// once with fractions of the screen. Every call goes through the real gateway
// and its shared quota queue. Candidates are OpenRouter's free models that
// take images and tools, from its public catalog, unless --models names them.
//
//   pnpm --filter @ofa/llm spike:vision [--runs 1] [--models a,b] [--out file.json]
//
// Needs LLM_API_KEY (an OpenRouter key) in the root .env. The key is never
// printed. The result orders OPENROUTER_DEFAULT_VISION and picks the
// convention desktop.click_at uses.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { asId, type LLMMessage, type TenantContext, type ToolDescriptor } from "@ofa/core";
import { createModelGateway } from "../gateway";
import { createOpenRouterProvider } from "../providers/openrouter";

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Run inside the repository");
    dir = parent;
  }
  return dir;
}

const root = repoRoot();
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "1" },
    models: { type: "string" },
    out: { type: "string", default: join(tmpdir(), "ofa-vision-spike.json") },
  },
});

const WIDTH = 1280;
const HEIGHT = 800;
const image = readFileSync(join(root, "evals/fixtures/desktop/desktop-apps.png")).toString(
  "base64",
);

type Convention = "pixels" | "fractions";

function clickAt(convention: Convention): ToolDescriptor {
  const axis = (size: number, side: string) =>
    convention === "pixels"
      ? { type: "number", description: `Pixels from the ${side} edge, 0 to ${size - 1}` }
      : { type: "number", description: `Fraction of the screen from the ${side} edge, 0 to 1` };
  return {
    name: "desktop.click_at",
    description:
      convention === "pixels"
        ? `Click at a point on the screen, in pixels of the screenshot (${WIDTH} wide, ${HEIGHT} high, from the top-left corner).`
        : "Click at a point on the screen, as fractions of its width and height from the top-left corner (0.5, 0.5 is the middle).",
    inputSchema: {
      type: "object",
      properties: { x: axis(WIDTH, "left"), y: axis(HEIGHT, "top") },
      required: ["x", "y"],
      additionalProperties: false,
    },
    annotations: { outbound: true },
    source: "builtin",
  };
}

const SYSTEM: LLMMessage = {
  role: "system",
  content:
    "You operate a Linux desktop by looking at screenshots. To act, call desktop.click_at. Answer directly when asked a question.",
};

interface Response {
  readonly text: string;
  readonly toolCalls: readonly { name: string; args: unknown }[];
}

interface Task {
  readonly id: string;
  readonly ask: string;
  readonly clicks: boolean;
  grade(response: Response, convention: Convention): { pass: boolean; note: string };
}

/** A click inside a box of the screenshot, read in the given convention (≤ 1 always as fractions). */
function clickIn(box: { x1: number; y1: number; x2: number; y2: number }) {
  return ({ toolCalls }: Response, convention: Convention) => {
    const call = toolCalls.find((c) => c.name === "desktop.click_at");
    if (!call) return { pass: false, note: "no click" };
    const { x, y } = (call.args ?? {}) as { x?: number; y?: number };
    if (typeof x !== "number" || typeof y !== "number") return { pass: false, note: "bad args" };
    const fractions = convention === "fractions" || (x <= 1 && y <= 1);
    const px = fractions ? x * WIDTH : x;
    const py = fractions ? y * HEIGHT : y;
    const inside = px >= box.x1 && px <= box.x2 && py >= box.y1 && py <= box.y2;
    return { pass: inside, note: `(${x}, ${y})→(${Math.round(px)}, ${Math.round(py)})` };
  };
}

const TASKS: Task[] = [
  {
    id: "click_menu",
    ask: "Click the File menu of the spreadsheet window, laptops.xlsx in Gnumeric.",
    clicks: true,
    grade: clickIn({ x1: 322, y1: 140, x2: 356, y2: 168 }),
  },
  {
    id: "read_screen",
    ask: "Which file is open in the window at the front? Reply with just its file name.",
    clicks: false,
    grade: ({ text }) => ({ pass: /ai-agents\.docx/i.test(text), note: text.trim().slice(0, 40) }),
  },
  {
    id: "click_dock",
    ask: "Bring the Agent terminal to the front by clicking its entry in the dock at the bottom.",
    clicks: true,
    grade: clickIn({ x1: 482, y1: 748, x2: 680, y2: 784 }),
  },
];

async function candidates(): Promise<string[]> {
  if (args.models)
    return args.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
  const models = await createOpenRouterProvider().listModels();
  return models
    .filter((m) => m.id.endsWith(":free") && m.supportsImages && m.supportsTools)
    .map((m) => m.id);
}

async function main() {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("Set LLM_API_KEY in the root .env");
  const models = await candidates();
  const runs = Math.max(1, Number(args.runs));
  const ctx: TenantContext = { workspaceId: asId("spike"), userId: asId("spike") };
  const conventions: Convention[] = ["pixels", "fractions"];
  console.log(
    `Vision spike: ${models.length} models × ${TASKS.length} tasks × ${conventions.length} conventions × ${runs} runs`,
  );

  type Score = { passed: number; total: number; notes: string[]; ms: number };
  const results: Record<string, Record<Convention, Score>> = {};
  for (const model of models) {
    const gateway = createModelGateway({
      providers: [createOpenRouterProvider()],
      apiKey: async () => apiKey,
      tiers: { fast: [{ provider: "openrouter", model }] },
      maxQueueWaitMs: 120_000,
    });
    results[model] = {} as Record<Convention, Score>;
    for (const convention of conventions) {
      const score: Score = { passed: 0, total: 0, notes: [], ms: 0 };
      for (let run = 0; run < runs; run += 1) {
        for (const task of TASKS) {
          // The reading task doesn't depend on the convention: ask it once.
          if (!task.clicks && convention !== "pixels") continue;
          score.total += 1;
          try {
            const response = await gateway.generate(
              {
                tier: "fast",
                messages: [
                  SYSTEM,
                  {
                    role: "user",
                    content: task.ask,
                    images: [{ data: image, mediaType: "image/png" }],
                  },
                ],
                tools: task.clicks ? [clickAt(convention)] : [],
                maxOutputTokens: 800,
                temperature: 0,
                reasoning: "none",
              },
              ctx,
            );
            score.ms += response.durationMs;
            const grade = task.grade(response, convention);
            if (grade.pass) score.passed += 1;
            score.notes.push(`${task.id}:${grade.pass ? "ok" : "no"} ${grade.note}`);
          } catch (error) {
            score.notes.push(
              `${task.id}:error ${error instanceof Error ? error.message.slice(0, 100) : error}`,
            );
          }
        }
      }
      results[model][convention] = score;
      console.log(
        `${String(score.passed).padStart(2)}/${score.total}  ${convention.padEnd(9)} ${model}  ${score.notes.join(" | ").replace(/\s+/g, " ")}`,
      );
    }
  }
  writeFileSync(args.out, JSON.stringify(results, null, 2));
  console.log(`Saved ${args.out}`);
}

await main();
