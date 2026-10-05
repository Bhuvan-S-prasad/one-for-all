import {
  strictest,
  urlKey,
  type AgentDirectory,
  type AgentGrantRule,
  type PolicyDecision,
  type PolicyEngine,
  type Verdict,
} from "@ofa/core";

// Policy in code (hard rule 5, ADR-0013). Each source gives a verdict and the
// strictest wins; nothing later can loosen it. This is the M2 subset: grants,
// risk annotations and taint escalation. Workspace and personal rules, the
// always-human list and approvals arrive in M4.

/**
 * Tools of the platform itself, available to every agent without a grant:
 * reopening its own saved output (M3.06). A grant can still block one.
 */
export const PLATFORM_TOOLS: ReadonlySet<string> = new Set(["artifacts.read"]);

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

export interface PolicyEngineOptions {
  readonly agents: AgentDirectory;
}

export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  return {
    async evaluate({ ctx, tool, args, tainted, knownUrls }): Promise<PolicyDecision> {
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

      let verdict: Verdict = grant.mode;
      const reasons = [`granted as ${grant.mode}`];
      const tighten = (next: Verdict, reason: string) => {
        verdict = strictest(verdict, next);
        reasons.push(reason);
      };

      // 2. Risk annotations: destructive actions always need a person.
      if (tool.annotations.destructive) tighten("approve", "destructive tools need approval");

      // 3. Taint escalation (§10.3): after reading untrusted content, anything
      //    that sends data out needs approval, whatever the grant says.
      if (tainted && tool.annotations.outbound) {
        tighten("approve", "outbound tool in a run that read untrusted content");
      }
      //    Opening an address nobody gave the run is sending data out too: a
      //    page can ask for `evil.example/?email=…`.
      const field = tool.annotations.opensUrl;
      const url = field ? (args as Record<string, unknown> | null)?.[field] : undefined;
      if (tainted && typeof url === "string" && !knownUrls?.has(urlKey(url))) {
        tighten(
          "approve",
          "opens an address that came from neither the person nor anything it read, in a run that read untrusted content",
        );
      }

      return { verdict, reasons };
    },
  };
}
