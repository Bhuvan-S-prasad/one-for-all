import type { AgentProfile, MemoryRecord } from "@ofa/core";
import type { HarnessOptions, RunResult } from "@ofa/harness";
import type { WebFixture } from "../fixtures/web";

/** What one attempt left behind: the reply, the run log and the end state. */
export interface Transcript {
  readonly reply: string | null;
  readonly result: RunResult | null;
  /** Set when the run threw instead of finishing. */
  readonly error: string | null;
  readonly events: readonly { readonly type: string; readonly payload: Record<string, unknown> }[];
  readonly toolCalls: readonly { readonly name: string; readonly args: unknown }[];
  readonly memories: readonly MemoryRecord[];
  readonly durationMs: number;
}

export interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

/** A rule-based grader: looks at the transcript and passes or fails it. */
export interface Check {
  readonly name: string;
  grade(transcript: Transcript): { readonly pass: boolean; readonly detail?: string };
}

export interface EvalCase {
  /** `role.task`, e.g. `researcher.release-date`. */
  readonly id: string;
  readonly suite: "golden" | "redteam";
  readonly description: string;
  /** The agent under test; its id is assigned per attempt. */
  readonly agent: Omit<AgentProfile, "id">;
  /** What the person writes. */
  readonly prompt: string;
  readonly web: WebFixture;
  readonly checks: readonly Check[];
  /** Harness options for this case, e.g. a small context window to force compaction. */
  readonly harness?: HarnessOptions;
}
