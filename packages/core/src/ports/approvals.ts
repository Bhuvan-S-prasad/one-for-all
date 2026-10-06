import type { AgentId, RunId } from "../ids";
import type { RunContext, TenantContext } from "../tenant";
import type { Verdict } from "./policy";

// Approvals (ARCHITECTURE.md §6.2, §10.2): when policy says a person must
// agree first, the run pauses on a durable wait and the person answers from
// the chat or the Approvals page. Nothing runs until they do.

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** An answer for this one call, or for every call like it on the same site for the rest of the run. */
export const APPROVAL_SCOPES = ["once", "site"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/** How long a run waits for an answer before carrying on without the action. */
export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface ApprovalRecord {
  readonly id: string;
  readonly runId: RunId;
  readonly agentId: AgentId;
  /** The run's chat, if it has one. */
  readonly threadId: string | null;
  /** The step in the run, e.g. `tool-3-0`. */
  readonly toolCallId: string;
  readonly tool: string;
  /** Redacted, as the tool would receive them. */
  readonly args: unknown;
  /** What the call would do, in plain words, for the person deciding. */
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly verdict: Verdict;
  /** The site the person may allow for the rest of the run; null when only a one-off answer fits. */
  readonly site: string | null;
  readonly scope: ApprovalScope;
  readonly status: ApprovalStatus;
  readonly decidedBy: string | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly expiresAt: Date;
}

export interface ApprovalInput {
  readonly toolCallId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly verdict: Verdict;
  readonly site?: string | null;
  readonly expiresAt: Date;
}

export interface ApprovalStore {
  /** Ask for one. A retried step gets the approval it asked for the first time. */
  request(ctx: RunContext, input: ApprovalInput): Promise<ApprovalRecord>;
  get(ctx: TenantContext, id: string): Promise<ApprovalRecord | null>;
  /** Settle a pending approval; null if it was not pending any more (someone answered first). */
  decide(
    ctx: TenantContext,
    id: string,
    input: {
      readonly status: Exclude<ApprovalStatus, "pending">;
      readonly decidedBy: string | null;
      /** `site` only for an approval that has one. */
      readonly scope?: ApprovalScope;
    },
  ): Promise<ApprovalRecord | null>;
  /** Pending approvals, newest first, optionally for one agent or run. */
  listPending(
    ctx: TenantContext,
    filter?: { readonly agentId?: string; readonly runId?: string },
  ): Promise<ApprovalRecord[]>;
  /** A stopped run's open requests: nothing is waiting for them any more. */
  expireForRun(ctx: TenantContext, runId: string): Promise<number>;
}
