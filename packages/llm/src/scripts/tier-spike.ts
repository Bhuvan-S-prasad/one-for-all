// Tier spike (M2.05): which free models call tools reliably enough to serve
// the fast, standard and strong tiers? Six small tool-calling tasks per model,
// every call through the real gateway and its shared quota queue.
//
//   pnpm --filter @ofa/llm spike [--runs 2] [--max-calls 45] [--models a,b] [--out file.json]
//
// Needs LLM_API_KEY (an OpenRouter key) in the root .env. The key is never
// printed. Moves to evals/ as a tier-qualification suite in M2.23.

import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  asId,
  type LLMMessage,
  type LLMResponse,
  type TenantContext,
  type ToolDescriptor,
} from "@ofa/core";
import { createModelGateway } from "../gateway";
import { createMemoryRateLimiter } from "../queue";
import { createOpenRouterProvider } from "../providers/openrouter";

function loadRootEnv(): void {
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  if (existsSync(join(dir, ".env"))) process.loadEnvFile(join(dir, ".env"));
}

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "1" },
    "max-calls": { type: "string", default: "45" },
    "per-day": { type: "string", default: "50" },
    models: { type: "string" },
    concurrency: { type: "string", default: "10" },
    out: { type: "string", default: join(tmpdir(), "ofa-tier-spike.json") },
  },
});

// ── Tools ───────────────────────────────────────────────────────────────────

function toolDef(
  name: string,
  description: string,
  properties: object,
  required: string[],
): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: {},
    source: "builtin",
  };
}

const weather = toolDef(
  "weather.current",
  "Current weather for a city.",
  { city: { type: "string" } },
  ["city"],
);
const search = toolDef(
  "web.search",
  "Search the web. Returns titles, links and snippets.",
  { query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 10 } },
  ["query"],
);
const calendar = toolDef(
  "calendar.create_event",
  "Create a calendar event.",
  {
    title: { type: "string" },
    start: { type: "string", description: "ISO 8601 date-time with time zone" },
    duration_minutes: { type: "integer", minimum: 5 },
    attendees: { type: "array", items: { type: "string", description: "Email address" } },
  },
  ["title", "start", "duration_minutes"],
);
const email = toolDef(
  "email.send",
  "Send an email.",
  { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
  ["to", "subject", "body"],
);
const toolbox = [search, calendar, email];

// ── Tasks ───────────────────────────────────────────────────────────────────

const SYSTEM: LLMMessage = {
  role: "system",
  content:
    "You are a capable assistant. Call a tool when it is needed to answer; otherwise answer directly and briefly. Today is 2026-10-01.",
};

interface Grade {
  readonly pass: boolean;
  readonly note: string;
}

interface Task {
  readonly id: string;
  readonly tools: readonly ToolDescriptor[];
  readonly messages: readonly LLMMessage[];
  grade(response: LLMResponse): Grade;
}

const str = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? ""));
const argsOf = (call: { args: unknown }) => (call.args ?? {}) as Record<string, unknown>;

const TASKS: Task[] = [
  {
    id: "single_tool",
    tools: [weather],
    messages: [SYSTEM, { role: "user", content: "What's the weather in Paris right now?" }],
    grade: ({ toolCalls }) => {
      const call = toolCalls.find((c) => c.name === "weather.current");
      const ok = !!call && !call.invalid && /paris/i.test(str(argsOf(call).city));
      return { pass: ok, note: call ? str(call.args) : "no tool call" };
    },
  },
  {
    id: "choose_tool",
    tools: toolbox,
    messages: [
      SYSTEM,
      { role: "user", content: "Find recent news about the James Webb Space Telescope." },
    ],
    grade: ({ toolCalls }) => {
      const right =
        toolCalls.length > 0 && toolCalls.every((c) => c.name === "web.search" && !c.invalid);
      const ok = right && toolCalls.some((c) => /webb/i.test(str(argsOf(c).query)));
      return { pass: ok, note: toolCalls.map((c) => c.name).join(",") || "no tool call" };
    },
  },
  {
    id: "no_tool",
    tools: toolbox,
    messages: [
      SYSTEM,
      { role: "user", content: "What is 12 times 7? Reply with just the number." },
    ],
    grade: ({ toolCalls, text }) => ({
      pass: toolCalls.length === 0 && /\b84\b/.test(text),
      note: toolCalls.length ? `called ${toolCalls[0]?.name}` : text.slice(0, 40),
    }),
  },
  {
    id: "structured_args",
    tools: toolbox,
    messages: [
      SYSTEM,
      {
        role: "user",
        content:
          "Book a 45 minute meeting called 'Design review' on 2026-10-05 at 14:00 UTC with ana@example.com and raj@example.com.",
      },
    ],
    grade: ({ toolCalls }) => {
      const call = toolCalls.find((c) => c.name === "calendar.create_event");
      if (!call || call.invalid) return { pass: false, note: call?.invalid ?? "no calendar call" };
      const a = argsOf(call);
      const attendees = Array.isArray(a.attendees)
        ? a.attendees.map(str).join(" ").toLowerCase()
        : "";
      const ok =
        a.duration_minutes === 45 &&
        /design review/i.test(str(a.title)) &&
        /^2026-10-05T14:00/.test(str(a.start)) &&
        attendees.includes("ana@example.com") &&
        attendees.includes("raj@example.com");
      return { pass: ok, note: JSON.stringify(a).slice(0, 160) };
    },
  },
  {
    id: "use_result",
    tools: toolbox,
    messages: [
      SYSTEM,
      { role: "user", content: "When was pgvector 0.9 released? Search if you need to." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "web.search", args: { query: "pgvector 0.9 release date" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "web.search",
        content:
          '[{"title":"pgvector 0.9.0 released","url":"https://example.org/pgvector-0-9","snippet":"pgvector 0.9.0 was released on 2026-09-12 with faster HNSW builds."}]',
      },
    ],
    grade: ({ toolCalls, text }) => ({
      pass:
        toolCalls.length === 0 &&
        /(2026-09-12|september\s+12|12\s+september|sept?\.?\s+12)/i.test(text),
      note: toolCalls.length ? `called ${toolCalls[0]?.name} again` : text.slice(0, 60),
    }),
  },
  {
    // Strict: both lookups in one turn (parallel calls). A model that searches
    // one city now and the other next step still works in the agent loop.
    id: "two_lookups",
    tools: toolbox,
    messages: [
      SYSTEM,
      { role: "user", content: "Look up the current population of Lisbon and of Porto." },
    ],
    grade: ({ toolCalls }) => {
      const queries = toolCalls
        .filter((c) => c.name === "web.search" && !c.invalid)
        .map((c) => str(argsOf(c).query));
      const all = queries.join(" ");
      return {
        pass: /lisbon/i.test(all) && /porto/i.test(all),
        note: `${queries.length} search${queries.length === 1 ? "" : "es"}`,
      };
    },
  },
];

// ── Run ─────────────────────────────────────────────────────────────────────

interface Result {
  model: string;
  task: string;
  run: number;
  pass: boolean;
  note: string;
  ms?: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

async function main(): Promise<void> {
  loadRootEnv();
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    console.error("Set LLM_API_KEY (your OpenRouter key) in the root .env, then run again.");
    process.exit(1);
  }
  const runs = Number(args.runs);
  const maxCalls = Number(args["max-calls"]);
  const perDay = Number(args["per-day"]);

  const provider = createOpenRouterProvider({ freeRequestsPerDay: perDay });
  const catalog = await provider.listModels();
  const wanted = args.models?.split(",").map((m) => m.trim());
  const candidates = catalog
    .filter((m) => (wanted ? wanted.includes(m.id) : m.id.endsWith(":free")))
    .filter((m) => m.supportsTools && m.contextWindow >= 32_768 && !/safety|guard/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const perModel = TASKS.length * runs;
  const models = candidates.slice(0, Math.max(1, Math.floor(maxCalls / perModel)));
  const skipped = candidates.slice(models.length).map((m) => m.id);
  console.log(
    `${models.length} models × ${TASKS.length} tasks × ${runs} run(s) = ${models.length * perModel} calls`,
  );
  if (skipped.length) console.log(`Over --max-calls, skipped: ${skipped.join(", ")}`);

  // One queue for every call, exactly as agents share it in production.
  const limiter = createMemoryRateLimiter();
  const ctx: TenantContext = { workspaceId: asId("spike"), userId: asId("spike") };
  const gateways = new Map(
    models.map((m) => [
      m.id,
      createModelGateway({
        providers: [provider],
        apiKey: async () => apiKey,
        tiers: { fast: [{ provider: provider.id, model: m.id }] },
        limiter,
        maxQueueWaitMs: 15 * 60_000,
        timeoutMs: 60_000,
      }),
    ]),
  );

  // Interleaved (run, task, model) so one slow model never holds every worker.
  const jobs = Array.from({ length: runs }, (_, run) =>
    TASKS.flatMap((task) => models.map((m) => ({ model: m.id, task, run }))),
  ).flat();
  const results: Result[] = [];
  const retries = new Map<string, number>();
  let next = 0;
  async function worker(): Promise<void> {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      const gateway = gateways.get(job.model);
      if (!gateway) continue;
      try {
        const request = {
          tier: "fast" as const,
          messages: job.task.messages,
          tools: job.task.tools,
          maxOutputTokens: 1_024,
          temperature: 0.2,
        };
        // Busy free models fail transiently; retry twice so the score measures
        // tool calling. Retries are counted as a separate availability signal.
        const response = await (async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await gateway.generate(request, ctx);
            } catch (error) {
              const code = (error as { modelCode?: string }).modelCode;
              const transient = ["rate_limited", "capacity", "unavailable", "unknown", "timeout"];
              if (attempt >= 2 || !code || !transient.includes(code)) throw error;
              retries.set(job.model, (retries.get(job.model) ?? 0) + 1);
              const wait = (error as { retryAfterMs?: number }).retryAfterMs ?? 0;
              await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 15_000), 60_000)));
            }
          }
        })();
        const grade = job.task.grade(response);
        results.push({
          model: job.model,
          task: job.task.id,
          run: job.run,
          ...grade,
          ms: response.durationMs,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        });
      } catch (error) {
        const code = (error as { modelCode?: string }).modelCode ?? "error";
        const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
        results.push({
          model: job.model,
          task: job.task.id,
          run: job.run,
          pass: false,
          note: "",
          error: `${code}: ${message}`,
        });
      }
      const last = results[results.length - 1];
      if (last) {
        const outcome = last.error
          ? `ERROR ${last.error}`
          : `${last.pass ? "PASS" : "FAIL"} ${last.note}`;
        console.log(
          `${results.length}/${jobs.length} ${last.model} ${last.task} ${outcome}`.slice(0, 240),
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  console.log("\n");

  const rows = models.map((m) => {
    const mine = results.filter((r) => r.model === m.id);
    const ok = mine.filter((r) => r.ms !== undefined);
    const latency = ok.map((r) => r.ms ?? 0).sort((a, b) => a - b);
    const median = latency.length ? latency[Math.floor(latency.length / 2)] : undefined;
    const byTask = TASKS.map((t) => {
      const runsFor = mine.filter((r) => r.task === t.id);
      return `${runsFor.filter((r) => r.pass).length}/${runsFor.length}`;
    });
    return {
      model: m.id,
      context: m.contextWindow,
      passed: mine.filter((r) => r.pass).length,
      total: mine.length,
      errors: mine.filter((r) => r.error).length,
      retries: retries.get(m.id) ?? 0,
      medianMs: median,
      byTask,
    };
  });
  rows.sort((a, b) => b.passed - a.passed || (a.medianMs ?? 1e9) - (b.medianMs ?? 1e9));

  console.log(
    `| Model | Context | Passed | Errors | Retries | Median latency | ${TASKS.map((t) => t.id).join(" | ")} |`,
  );
  console.log(`|---|---:|---:|---:|---:|---:|${TASKS.map(() => "---:").join("|")}|`);
  for (const row of rows) {
    const ctxK = `${Math.round(row.context / 1024)}k`;
    const ms = row.medianMs === undefined ? "–" : `${(row.medianMs / 1000).toFixed(1)} s`;
    console.log(
      `| \`${row.model}\` | ${ctxK} | ${row.passed}/${row.total} | ${row.errors} | ${row.retries} | ${ms} | ${row.byTask.join(" | ")} |`,
    );
  }

  const out = resolve(args.out);
  writeFileSync(
    out,
    JSON.stringify({ date: new Date().toISOString(), runs, rows, results }, null, 2),
  );
  console.log(`\nDetails: ${out}`);
}

await main();
