import type { AgentProfile, ApprovalRecord, MemoryRecord } from "@ofa/core";
import type { HarnessOptions, RunResult } from "@ofa/harness";
import type { MailboxFixture, MailRecord } from "../fixtures/mailbox";
import type { FixtureSite, SiteRecord } from "../fixtures/site";
import type { WebFixture } from "../fixtures/web";
import type { SavedFile } from "./computer";

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
  /**
   * Files the run made or changed on the agent's computer, with their text,
   * for cases with a computer (DT.12); null otherwise.
   */
  readonly files: readonly SavedFile[] | null;
  /** Files sent to the person with the reply (`files.send`), in order. */
  readonly sent: readonly SentFile[];
  /** Work handed to teammates (M5.13), one entry per handoff, in order. */
  readonly children: readonly ChildTranscript[];
  /**
   * For a case that continues (`continueWith`): the first run, which the rest
   * of the transcript follows. Null otherwise.
   */
  readonly before: {
    readonly reply: string | null;
    readonly stopReason: string | null;
    readonly toolCalls: readonly { readonly name: string; readonly args: unknown }[];
  } | null;
  readonly durationMs: number;
}

/** One handoff: who did it, from what brief, and what came back. */
export interface ChildTranscript {
  /** The teammate's handle. */
  readonly agent: string;
  readonly brief: string;
  readonly reply: string | null;
  readonly tainted: boolean;
  readonly toolCalls: readonly { readonly name: string; readonly args: unknown }[];
}

/** A file the agent sent under its reply. */
export interface SentFile {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
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
   * A real computer (DT.12): the agent works in the dev sandbox from
   * `pnpm infra:up`, with its terminal, files and desktop apps. `files` are
   * put in place first (paths may start with `~`, the agent's home).
   * Skipped when the sandbox isn't running.
   */
  readonly computer?: { readonly files?: Readonly<Record<string, string>> };
  /**
   * The person answering approval requests: true approves. By default they
   * approve everything, as someone watching a task they asked for would.
   */
  readonly person?: (approval: ApprovalRecord) => boolean;
  readonly checks: readonly Check[];
  /** Harness options for this case, e.g. a small context window to force compaction. */
  readonly harness?: HarnessOptions;
  /**
   * Teammates the agent under test may hand work to (M5.13); each child runs
   * on the same harness, tools and policy, from the brief only.
   */
  readonly team?: readonly Omit<AgentProfile, "id">[];
  /**
   * The person writes again in the same chat once the first run ends
   * (ADR-0045), e.g. "continue", maybe after changing the agent (a larger
   * budget). The transcript is the second run's; the first is in `before`.
   */
  readonly continueWith?: {
    readonly prompt: string;
    readonly agent?: Partial<Omit<AgentProfile, "id">>;
  };
}
