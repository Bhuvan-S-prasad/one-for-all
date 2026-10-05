/* eslint-disable no-console -- a command-line runner prints its report */
// Run the evals against live models (ARCHITECTURE.md §12).
//
//   pnpm eval [--suite golden|redteam] [--case id] [--k 3] [--tier fast]
//             [--model openrouter:vendor/model:free] [--out report.json] [--list]
//
// --model qualifies one model: every tier uses only it. Needs LLM_API_KEY in
// the root .env for providers that take a key; the key is never printed.
// Uses real quota: each attempt makes a few model calls.

import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { MODEL_TIERS, type ModelTier } from "@ofa/core";
import {
  createModelGateway,
  createOpenRouterProvider,
  parseModelList,
  type ModelProvider,
  type TierOverrides,
} from "@ofa/llm";
import { injectionSuite } from "../redteam/injection";
import { operatorSuite } from "../suites/operator";
import { researcherSuite } from "../suites/researcher";
import { runCases, type AttemptReport } from "./runner";
import type { EvalCase } from "./types";

const ALL_CASES: readonly EvalCase[] = [...researcherSuite, ...operatorSuite, ...injectionSuite];

/** Providers this runner can use; mirrors the composition root (ADR-0022). */
const MODEL_PROVIDERS: Record<string, () => ModelProvider> = {
  openrouter: () => createOpenRouterProvider({ baseURL: process.env.LLM_BASE_URL || undefined }),
};

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
    suite: { type: "string" },
    case: { type: "string" },
    k: { type: "string", default: "1" },
    tier: { type: "string" },
    model: { type: "string" },
    out: { type: "string", default: join(tmpdir(), "ofa-evals.json") },
    list: { type: "boolean", default: false },
  },
});

const cases = ALL_CASES.filter(
  (c) => (!args.suite || c.suite === args.suite) && (!args.case || c.id.includes(args.case)),
);

if (args.list) {
  for (const c of cases) console.log(`${c.suite.padEnd(8)} ${c.id}\n         ${c.description}`);
  process.exit(0);
}
if (cases.length === 0) {
  console.error("No cases match. Try --list.");
  process.exit(2);
}
const tier = args.tier as ModelTier | undefined;
if (tier && !MODEL_TIERS.includes(tier)) {
  console.error(`--tier must be one of ${MODEL_TIERS.join(", ")}`);
  process.exit(2);
}
const k = Math.max(1, Number.parseInt(args.k, 10) || 1);

loadRootEnv();
const providerId = process.env.LLM_PROVIDER || "openrouter";
const makeProvider = MODEL_PROVIDERS[providerId];
if (!makeProvider) {
  console.error(`Unknown LLM_PROVIDER "${providerId}".`);
  process.exit(2);
}
const provider = makeProvider();
const apiKey = process.env.LLM_API_KEY || undefined;
if (provider.requiresApiKey && !apiKey) {
  console.error(`Add LLM_API_KEY to the root .env to run evals against ${provider.label}.`);
  process.exit(2);
}

const ids = [provider.id];
const only = args.model ? parseModelList(args.model, ids, provider.id) : null;
const tiers: TierOverrides = Object.fromEntries(
  MODEL_TIERS.map((t) => [
    t,
    only ?? parseModelList(process.env[`LLM_MODELS_${t.toUpperCase()}`], ids, provider.id),
  ]),
);
const llm = createModelGateway({
  providers: [provider],
  tiers,
  apiKey: async () => apiKey,
  // Evals wait for quota rather than fail: a minute's wait is fine here.
  maxQueueWaitMs: 65_000,
});

const selected = tier
  ? cases.map((c) => ({ ...c, agent: { ...c.agent, modelTier: tier } }))
  : cases;

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
function printAttempt(evalCase: EvalCase, n: number, report: AttemptReport): void {
  console.log(
    `${report.pass ? "PASS" : "FAIL"}  ${evalCase.id} #${n + 1}  ` +
      `${seconds(report.durationMs)} · ${report.modelCalls} model calls · ${report.tokens} tokens · ` +
      (report.models.join(", ") || "no model answered"),
  );
  for (const check of report.checks.filter((c) => !c.pass)) {
    console.log(`        ✗ ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
  }
}

console.log(
  `Running ${selected.length} case(s) × ${k} on ${provider.label}` +
    (only ? ` (only ${args.model})` : "") +
    (tier ? ` at the ${tier} tier` : ""),
);
const reports = await runCases(selected, { llm, k, onAttempt: printAttempt });

console.log("\ncase                              pass@1   pass^k");
for (const r of reports) {
  console.log(
    `${r.id.padEnd(34)}${`${Math.round(r.passAt1 * 100)}%`.padEnd(9)}${r.passAllK ? "yes" : "no"}`,
  );
}
writeFileSync(
  args.out,
  JSON.stringify(
    { at: new Date().toISOString(), provider: provider.id, model: args.model, tier, k, reports },
    null,
    2,
  ),
);
console.log(`\nReport: ${args.out}`);
process.exit(reports.every((r) => r.passAllK) ? 0 : 1);
