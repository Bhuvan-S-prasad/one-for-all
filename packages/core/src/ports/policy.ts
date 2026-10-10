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
  /**
   * Addresses the run was given (`urlKey` form): in the person's messages or
   * in tool results. Absent means none.
   */
  readonly knownUrls?: ReadonlySet<string>;
  /** The site the call acts on (`shop.example`), when the tool can tell. */
  readonly site?: string;
  /**
   * Sites a person allowed for the rest of this run ("allow on this site for
   * this task"): there, taint escalation no longer asks. Nothing else relaxes.
   */
  readonly allowedSites?: ReadonlySet<string>;
}

export interface PolicyDecision {
  readonly verdict: Verdict;
  /** Human-readable reasons, one per verdict source that fired. */
  readonly reasons: readonly string[];
  /**
   * Set when only taint escalation held the call, on a known site: a person
   * may then allow that site for the rest of the run instead of answering
   * each call.
   */
  readonly allowSite?: string;
}

/** Ask before a tool runs, or let it run without asking (ARCHITECTURE.md §10.2). */
export const POLICY_RULE_EFFECTS = ["ask_first", "allow_auto"] as const;
export type PolicyRuleEffect = (typeof POLICY_RULE_EFFECTS)[number];

export interface PolicyRule {
  readonly id: string;
  /** `*`, a tool (`remember`, `gmail.send`) or an app (`gmail.*`). */
  readonly tool: string;
  readonly effect: PolicyRuleEffect;
  /** Workspace rules come from owners and admins; personal ones only ask first. */
  readonly scope: "workspace" | "personal";
  /** One agent, or every agent when null. */
  readonly agentId: string | null;
  readonly description: string;
}

export interface PolicyRuleStore {
  /** The enabled rules that apply to a run: the workspace's, and its person's own, for this agent or all. */
  listForRun(ctx: RunContext): Promise<PolicyRule[]>;
}

/** Whether a rule's tool pattern covers a tool name. */
export function ruleMatches(pattern: string, toolName: string): boolean {
  if (pattern === "*" || pattern === toolName) return true;
  return pattern.endsWith(".*") && toolName.startsWith(pattern.slice(0, -1));
}

export interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}
