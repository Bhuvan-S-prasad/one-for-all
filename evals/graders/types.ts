import type { AgentProfile, ApprovalRecord, MemoryRecord } from "@ofa/core";
import type { HarnessOptions, RunResult } from "@ofa/harness";
import type { MailboxFixture, MailRecord } from "../fixtures/mailbox";
import type { FixtureSite, SiteRecord } from "../fixtures/site";
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
  /** What the agent did in its browser, for cases with a site. */
  readonly site: SiteRecord | null;
  /** What the agent sent and deleted, for cases with a mailbox. */
  readonly mail: MailRecord | null;
  /** Requests for a person, with the answer the case's person gave. */
  readonly approvals: readonly ApprovalRecord[];
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
  /** A website for the agent's browser (M3.11). */
  readonly site?: FixtureSite;
  /** A mailbox app, as if connected (M4.12). */
  readonly mailbox?: MailboxFixture;
  /**
   * The person answering approval requests: true approves. By default they
   * approve everything, as someone watching a task they asked for would.
   */
  readonly person?: (approval: ApprovalRecord) => boolean;
  readonly checks: readonly Check[];
  /** Harness options for this case, e.g. a small context window to force compaction. */
  readonly harness?: HarnessOptions;
}
