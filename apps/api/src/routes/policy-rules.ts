import {
  createPolicyRuleSchema,
  updatePolicyRuleSchema,
  type PolicyRuleItem,
  type PolicyRuleList,
} from "@ofa/contracts";
import { AppError, ForbiddenError, NotFoundError } from "@ofa/core";
import {
  createPolicyRule,
  deletePolicyRule,
  findPolicyRule,
  listPolicyRules,
  recordAudit,
  setPolicyRuleEnabled,
  type PolicyRuleRecord,
} from "@ofa/db";
import { Hono, type Context } from "hono";
import type { Container } from "../container";
import { requestMeta } from "../lib/request";
import { readJson } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Policy rules (ARCHITECTURE.md §10.2):
 *   GET    /api/policy-rules       the workspace's rules and your own
 *   POST   /api/policy-rules       add one
 *   PATCH  /api/policy-rules/:id   { enabled }
 *   DELETE /api/policy-rules/:id
 *
 * Workspace rules are an owner's or admin's to change. Anyone can add rules
 * of their own, which only ask first: they can make things stricter for
 * their runs, never looser. Every change is audited.
 */
export function policyRuleRoutes(deps: Pick<Container, "db" | "sessions">) {
  /** Workspace rules need an owner or admin; personal ones are their person's. */
  function mayChange(c: Context<AppEnv>, scope: "workspace" | "personal"): void {
    const role = c.get("session").membership?.role;
    if (scope === "workspace" && role !== "owner" && role !== "admin") {
      throw new ForbiddenError("Only an owner or admin can change workspace rules");
    }
  }

  async function found(c: Context<AppEnv>): Promise<PolicyRuleRecord> {
    const rule = await findPolicyRule(deps.db, c.get("tenant"), c.req.param("id") ?? "");
    if (!rule) throw new NotFoundError("Rule");
    mayChange(c, rule.scope);
    return rule;
  }

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const items = await listPolicyRules(deps.db, c.get("tenant"));
      return c.json({ items: items.map(toPolicyRule) } satisfies PolicyRuleList);
    })
    .post("/", async (c) => {
      const tenant = c.get("tenant");
      const input = await readJson(c, createPolicyRuleSchema);
      mayChange(c, input.scope);
      let created: PolicyRuleRecord | null;
      try {
        created = await createPolicyRule(deps.db, tenant, input);
      } catch (error) {
        // The agent is not in this workspace.
        if ((error as { cause?: { code?: string } }).cause?.code === "23503") {
          throw new AppError("validation_failed", "That agent doesn't exist");
        }
        throw error;
      }
      if (!created) throw new AppError("conflict", "That rule already exists");
      await recordAudit(deps.db, tenant, {
        action: "policy.rule_created",
        targetType: "policy_rule",
        targetId: created.id,
        data: { tool: created.tool, effect: created.effect, scope: created.scope },
        ...requestMeta(c),
      });
      return c.json(toPolicyRule(created), 201);
    })
    .patch("/:id", async (c) => {
      const tenant = c.get("tenant");
      const rule = await found(c);
      const { enabled } = await readJson(c, updatePolicyRuleSchema);
      const updated = await setPolicyRuleEnabled(deps.db, tenant, rule.id, enabled);
      if (!updated) throw new NotFoundError("Rule");
      await recordAudit(deps.db, tenant, {
        action: enabled ? "policy.rule_enabled" : "policy.rule_disabled",
        targetType: "policy_rule",
        targetId: rule.id,
        data: { tool: rule.tool, effect: rule.effect, scope: rule.scope },
        ...requestMeta(c),
      });
      return c.json(toPolicyRule(updated));
    })
    .delete("/:id", async (c) => {
      const tenant = c.get("tenant");
      const rule = await found(c);
      await deletePolicyRule(deps.db, tenant, rule.id);
      await recordAudit(deps.db, tenant, {
        action: "policy.rule_deleted",
        targetType: "policy_rule",
        targetId: rule.id,
        data: { tool: rule.tool, effect: rule.effect, scope: rule.scope },
        ...requestMeta(c),
      });
      return c.body(null, 204);
    });
}

function toPolicyRule(rule: PolicyRuleRecord): PolicyRuleItem {
  return {
    id: rule.id,
    tool: rule.tool,
    effect: rule.effect,
    scope: rule.scope,
    agentId: rule.agentId,
    description: rule.description,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
  };
}
