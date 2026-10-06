import {
  ruleMatches,
  strictest,
  urlKey,
  type AgentDirectory,
  type AgentGrantRule,
  type HumanOnlyKind,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyRule,
  type PolicyRuleStore,
  type ToolDescriptor,
  type Verdict,
} from "@ofa/core";

// Policy in code (hard rule 5, ADR-0013, ARCHITECTURE.md §10.2). Each source
// gives a verdict and the strictest wins; nothing later can loosen it:
//
//   1. not granted, or blocked            deny
//   2. always-human list                  human
//   3. destructive annotation             approve
//   4. taint escalation (outbound, and    approve   a person can allow the
//      opening an address nobody gave)               site for the rest of the run
//   5. ask-first rules                    approve
//   6. allow-auto rules, if nothing above fired     auto
//   7. otherwise the grant's mode

/**
 * Tools of the platform itself, available to every agent without a grant:
 * reopening its own saved output (M3.06), loading an app's tools it was
 * granted (M4.05). A grant can still block one.
 */
export const PLATFORM_TOOLS: ReadonlySet<string> = new Set(["artifacts.read", "load_toolkit"]);

/** The grant that covers a tool: an exact name beats an app wildcard (`hubspot.*`). */
export function grantFor(
  grants: readonly AgentGrantRule[],
  toolName: string,
): AgentGrantRule | undefined {
  const exact = grants.find((g) => g.tool === toolName);
  if (exact) return exact;
  const app = toolName.includes(".") ? toolName.slice(0, toolName.indexOf(".")) : null;
  return app ? grants.find((g) => g.tool === `${app}.*`) : undefined;
}

/**
 * Words in a tool's action that put it on the always-human list, for tools
 * that don't declare `humanOnly` (most MCP servers don't). Matched as whole
 * words of the snake_case action, so `delete_page` matches and `deleted_items`
 * does not. Erring towards asking only costs a click.
 */
const HUMAN_ONLY_WORDS: Record<HumanOnlyKind, RegExp> = {
  payment: /(^|_)(pay|payment|payments|charge|refund|purchase|checkout|transfer|payout)(_|$)/,
  // Not `remove` or `archive`: removing a label or archiving an email loses nothing.
  deletion: /(^|_)(delete|destroy|purge|trash|erase)(_|$)/,
  permissions: /(^|_)(permission|permissions|password|passwords|role|roles|acl|access)(_|$)/,
  sharing: /(^|_)(share|unshare|publish|invite|collaborator|collaborators)(_|$)/,
};

const HUMAN_ONLY_REASONS: Record<HumanOnlyKind, string> = {
  payment: "payments always need a person",
  deletion: "deleting things always needs a person",
  permissions: "changing permissions or passwords always needs a person",
  sharing: "sharing with other people always needs a person",
};

/** Whether a tool is on the always-human list, and why. Read-only tools never are by name. */
export function humanOnlyKind(tool: ToolDescriptor): HumanOnlyKind | null {
  if (tool.annotations.humanOnly) return tool.annotations.humanOnly;
  if (tool.annotations.readOnly) return null;
  const action = (tool.name.includes(".") ? tool.name.slice(tool.name.indexOf(".") + 1) : tool.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  for (const [kind, words] of Object.entries(HUMAN_ONLY_WORDS)) {
    if (words.test(action)) return kind as HumanOnlyKind;
  }
  return null;
}

export interface PolicyEngineOptions {
  readonly agents: AgentDirectory;
  /** Workspace and personal rules. Without it, no rules apply. */
  readonly rules?: PolicyRuleStore;
}

interface Hold {
  readonly verdict: Verdict;
  readonly reason: string;
  /** Taint escalation: a person can allow the site for the rest of the run. */
  readonly taint?: boolean;
}

function ruleReason(rule: PolicyRule, what: string): string {
  const whose = rule.scope === "workspace" ? "a workspace rule" : "your own rule";
  return `${what} by ${whose}${rule.description ? `: ${rule.description}` : ""}`;
}

export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  return {
    async evaluate({
      ctx,
      tool,
      args,
      tainted,
      knownUrls,
      site,
      allowedSites,
    }): Promise<PolicyDecision> {
      const agent = await options.agents.get(ctx, ctx.agentId);
      const grant = agent
        ? (grantFor(agent.grants, tool.name) ??
          (PLATFORM_TOOLS.has(tool.name) ? { tool: tool.name, mode: "auto" as const } : undefined))
        : undefined;

      // 1. Not granted, or blocked by the user: nothing else matters.
      if (!grant)
        return { verdict: "deny", reasons: [`${tool.name} is not granted to this agent`] };
      if (grant.mode === "blocked") {
        return { verdict: "deny", reasons: [`${tool.name} is blocked for this agent`] };
      }

      const holds: Hold[] = [];
      const notes: string[] = [];

      // 2. The always-human list: no grant or rule makes these automatic.
      const kind = humanOnlyKind(tool);
      if (kind) holds.push({ verdict: "human", reason: HUMAN_ONLY_REASONS[kind] });

      // 3. Risk annotations: destructive actions always need a person.
      if (tool.annotations.destructive) {
        holds.push({ verdict: "approve", reason: "destructive tools need approval" });
      }

      // 4. Taint escalation (§10.3): after reading untrusted content, anything
      //    that sends data out needs approval, whatever the grant says. Opening
      //    an address nobody gave the run is sending data out too: a page can
      //    ask for `evil.example/?email=…`. A site the person allowed for this
      //    task is exempt from this source alone.
      if (tainted) {
        const taintHolds: Hold[] = [];
        if (tool.annotations.outbound) {
          taintHolds.push({
            verdict: "approve",
            reason: "outbound tool in a run that read untrusted content",
            taint: true,
          });
        }
        const field = tool.annotations.opensUrl;
        const url = field ? (args as Record<string, unknown> | null)?.[field] : undefined;
        if (typeof url === "string" && !knownUrls?.has(urlKey(url))) {
          taintHolds.push({
            verdict: "approve",
            reason:
              "opens an address that came from neither the person nor anything it read, in a run that read untrusted content",
            taint: true,
          });
        }
        if (taintHolds.length && site && allowedSites?.has(site)) {
          notes.push(`allowed on ${site} for this task`);
        } else {
          holds.push(...taintHolds);
        }
      }

      // 5–6. Rules. Personal rules only ask first (the database refuses
      //      anything else), so they can only tighten workspace rules.
      const rules = (await options.rules?.listForRun(ctx)) ?? [];
      const matching = rules.filter((r) => ruleMatches(r.tool, tool.name));
      for (const rule of matching.filter((r) => r.effect === "ask_first")) {
        holds.push({ verdict: "approve", reason: ruleReason(rule, "asks first") });
      }
      const allowAuto = matching.find((r) => r.effect === "allow_auto" && r.scope === "workspace");

      // 7. The grant's mode; an allow-auto rule replaces it only when nothing
      //    above fired.
      //    An app granted whole (`notion.*`) takes each MCP tool's default
      //    from its annotations (§9.1): reading runs, anything else asks.
      //    Naming the tool in a grant is the person's own choice and wins.
      const byWildcard = grant.tool !== tool.name && tool.source === "mcp";
      const mode: Verdict =
        byWildcard && grant.mode === "auto" && !tool.annotations.readOnly ? "approve" : grant.mode;
      const modeReason =
        mode === grant.mode
          ? `granted as ${mode}`
          : `granted as part of ${grant.tool}; tools that change things ask first`;
      const base = (fired: readonly Hold[]): { verdict: Verdict; reason: string } =>
        fired.length === 0 && allowAuto
          ? { verdict: "auto", reason: ruleReason(allowAuto, "runs without asking") }
          : { verdict: mode, reason: modeReason };

      const start = base(holds);
      const verdict = holds.reduce<Verdict>((v, h) => strictest(v, h.verdict), start.verdict);
      const reasons = [start.reason, ...holds.map((h) => h.reason), ...notes];

      // Would allowing the site be enough? Only if, without taint escalation,
      // the call would run on its own.
      const firm = holds.filter((h) => !h.taint);
      const withoutTaint = firm.reduce<Verdict>(
        (v, h) => strictest(v, h.verdict),
        base(firm).verdict,
      );
      const allowSite =
        site && verdict === "approve" && withoutTaint === "auto" && holds.some((h) => h.taint)
          ? site
          : undefined;

      return { verdict, reasons, ...(allowSite ? { allowSite } : {}) };
    },
  };
}
