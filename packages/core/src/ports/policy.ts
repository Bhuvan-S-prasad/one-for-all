import type { RunContext } from "../tenant";
import type { ToolDescriptor } from "./tools";

/** Ordered from least to most strict. The strictest verdict wins (ADR-0013). */
export const VERDICTS = ["auto", "approve", "human", "deny"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * What the user sets per tool on an agent (ARCHITECTURE.md §9.1). `blocked`
 * becomes a `deny` verdict; the others can still be tightened by policy.
 */
export const GRANT_MODES = ["auto", "approve", "blocked"] as const;
export type GrantMode = (typeof GRANT_MODES)[number];

export function strictest(a: Verdict, b: Verdict): Verdict {
  return VERDICTS.indexOf(a) >= VERDICTS.indexOf(b) ? a : b;
}

export interface PolicyInput {
  readonly ctx: RunContext;
  readonly tool: ToolDescriptor;
  readonly args: unknown;
  /** The run has read untrusted content. */
  readonly tainted: boolean;
}

export interface PolicyDecision {
  readonly verdict: Verdict;
  /** Human-readable reasons, one per verdict source that fired. */
  readonly reasons: readonly string[];
}

export interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}
