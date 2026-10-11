import type { LLMGateway } from "@ofa/core";
import type { EvalComputer } from "./computer";
import type { CheckResult, EvalCase, Transcript } from "./types";
import { runAttempt } from "./world";

// Runs each case k times and reports pass@1 (share of attempts that pass) and
// pass^k (every attempt passes), the metrics in ARCHITECTURE.md §12.

export interface AttemptReport {
  readonly pass: boolean;
  readonly checks: readonly CheckResult[];
  readonly durationMs: number;
  readonly modelCalls: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly models: readonly string[];
  readonly reply: string | null;
  /** The tool calls, in order, each cut to a line: what to read when a case fails. */
  readonly tools: readonly string[];
}

export interface CaseReport {
  readonly id: string;
  readonly suite: EvalCase["suite"];
  readonly attempts: readonly AttemptReport[];
  readonly passAt1: number;
  readonly passAllK: boolean;
}

export function grade(evalCase: EvalCase, transcript: Transcript): AttemptReport {
  const checks: CheckResult[] = evalCase.checks.map((check) => {
    try {
      return { name: check.name, ...check.grade(transcript) };
    } catch (error) {
      return { name: check.name, pass: false, detail: String(error) };
    }
  });
  const usage = transcript.result?.usage;
  return {
    pass: checks.every((c) => c.pass),
    checks,
    durationMs: transcript.durationMs,
    modelCalls: usage?.modelCalls ?? 0,
    tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    costUsd: usage?.costUsd ?? 0,
    models: [
      ...new Set(
        transcript.events
          .filter((e) => e.type === "model.called")
          .map((e) => String(e.payload.model)),
      ),
    ],
    reply: transcript.reply,
    tools: transcript.toolCalls.map((c) => {
      const line = `${c.name} ${JSON.stringify(c.args)}`;
      return line.length > 200 ? `${line.slice(0, 199)}…` : line;
    }),
  };
}

export interface RunOptions {
  readonly llm: LLMGateway;
  readonly k: number;
  readonly wait?: (ms: number) => Promise<void>;
  /** The computer for cases that need one (DT.12). */
  readonly computer?: EvalComputer | null;
  readonly onAttempt?: (evalCase: EvalCase, n: number, report: AttemptReport) => void;
}

export async function runCases(
  cases: readonly EvalCase[],
  options: RunOptions,
): Promise<CaseReport[]> {
  const reports: CaseReport[] = [];
  // One at a time: free models allow about 20 requests a minute in total.
  for (const evalCase of cases) {
    const attempts: AttemptReport[] = [];
    for (let n = 0; n < options.k; n += 1) {
      const transcript = await runAttempt(evalCase, {
        llm: options.llm,
        ...(options.wait ? { wait: options.wait } : {}),
        ...(options.computer ? { computer: options.computer } : {}),
      });
      const report = grade(evalCase, transcript);
      attempts.push(report);
      options.onAttempt?.(evalCase, n, report);
    }
    const passed = attempts.filter((a) => a.pass).length;
    reports.push({
      id: evalCase.id,
      suite: evalCase.suite,
      attempts,
      passAt1: attempts.length ? passed / attempts.length : 0,
      passAllK: attempts.length > 0 && passed === attempts.length,
    });
  }
  return reports;
}
