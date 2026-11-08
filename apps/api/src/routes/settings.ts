import {
  setLlmKeyRequestSchema,
  setSpendCapRequestSchema,
  updateWorkspaceSettingsRequestSchema,
  type LlmSettings,
  type SpendSummary,
  type UsageToday,
  type WorkspaceSettings,
} from "@ofa/contracts";
import {
  ForbiddenError,
  MODEL_TIERS,
  spendMonthStart,
  toCents,
  type TenantContext,
} from "@ofa/core";
import {
  createSpendLedger,
  getWorkspace,
  modelCallsSince,
  recordAudit,
  setSpendCap,
  setWorkspaceTimeZone,
  spendByAgentSince,
} from "@ofa/db";
import { Hono, type Context } from "hono";
import { llmKeySecretName, type Container } from "../container";
import { requestMeta } from "../lib/request";
import { readJson } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Model settings (M2.21):
 *   GET    /api/settings/llm       provider, whether a key is set (never the key), tier models
 *   PUT    /api/settings/llm/key   save this workspace's key in the vault (owner or admin)
 *   DELETE /api/settings/llm/key   remove it
 *   GET    /api/settings/usage     model requests today against the provider's daily quota (UX.11)
 *   GET    /api/settings/workspace the workspace time zone, for routines and reminders (M5.06)
 *   PUT    /api/settings/workspace change it (owner or admin)
 *   GET    /api/settings/spend     paid app credits this month, the cap, per agent (EN.15)
 *   PUT    /api/settings/spend     set or clear the monthly cap (owner or admin)
 */
export function settingsRoutes(
  deps: Pick<Container, "db" | "sessions" | "vault" | "llmProvider" | "tiers" | "config">,
) {
  const provider = deps.llmProvider;
  const secretName = llmKeySecretName(provider.id);

  function requireAdmin(c: Context<AppEnv>, what = "the model key"): TenantContext {
    const role = c.get("session").membership?.role;
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenError(`Only an owner or admin can change ${what}`);
    }
    return c.get("tenant");
  }

  async function settings(tenant: TenantContext): Promise<LlmSettings> {
    const saved = (await deps.vault.list(tenant)).find((s) => s.name === secretName);
    const fromEnv = deps.config.llm.provider === provider.id && !!deps.config.llm.apiKey;
    return {
      provider: { id: provider.id, label: provider.label, requiresApiKey: provider.requiresApiKey },
      key: {
        configured: !!saved || fromEnv,
        source: saved ? "workspace" : fromEnv ? "environment" : null,
        hint: saved?.hint ?? null,
      },
      tiers: Object.fromEntries(
        MODEL_TIERS.map((tier) => [tier, deps.tiers[tier].map((ref) => ref.model)]),
      ) as LlmSettings["tiers"],
    };
  }

  /** The quota day starts at UTC midnight, when free provider quotas reset. */
  async function usage(tenant: TenantContext): Promise<UsageToday> {
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const resetsAt = new Date(since.getTime() + 86_400_000);
    const calls = await modelCallsSince(deps.db, tenant, since);
    // The daily limit of the models in use: the tier models, and any called today.
    const models = new Set([
      ...MODEL_TIERS.flatMap((tier) => deps.tiers[tier].map((ref) => ref.model)),
      ...calls.map((c) => c.model),
    ]);
    const daily = [...models].flatMap((m) => provider.rateLimits(m)).find((l) => l.perDay);
    const counted = daily
      ? calls.filter((c) => provider.rateLimits(c.model).some((l) => l.bucket === daily.bucket))
      : calls;
    return {
      since: since.toISOString(),
      resetsAt: resetsAt.toISOString(),
      requests: counted.reduce((sum, c) => sum + c.calls, 0),
      dailyLimit: daily?.perDay ?? null,
      perMinute: daily?.perMinute ?? null,
    };
  }

  const ledger = createSpendLedger(deps.db);
  async function spending(tenant: TenantContext): Promise<SpendSummary> {
    const since = spendMonthStart(new Date());
    const [month, byAgent] = await Promise.all([
      ledger.month(tenant),
      spendByAgentSince(deps.db, tenant, since),
    ]);
    return {
      since: since.toISOString(),
      spentUsd: month.spentCents / 100,
      capUsd: month.capCents === null ? null : month.capCents / 100,
      byAgent: byAgent.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        calls: a.calls,
        spentUsd: a.spentCents / 100,
      })),
    };
  }

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/llm", async (c) => c.json(await settings(c.get("tenant"))))
    .get("/usage", async (c) => c.json(await usage(c.get("tenant"))))
    .get("/workspace", async (c) => {
      const workspace = await getWorkspace(deps.db, c.get("tenant"));
      return c.json({ timeZone: workspace.timeZone } satisfies WorkspaceSettings);
    })
    .put("/workspace", async (c) => {
      const tenant = requireAdmin(c, "workspace settings");
      const { timeZone } = await readJson(c, updateWorkspaceSettingsRequestSchema);
      await setWorkspaceTimeZone(deps.db, tenant, timeZone);
      return c.json({ timeZone } satisfies WorkspaceSettings);
    })
    .get("/spend", async (c) => c.json(await spending(c.get("tenant"))))
    .put("/spend", async (c) => {
      const tenant = requireAdmin(c, "the spending limit");
      const { capUsd } = await readJson(c, setSpendCapRequestSchema);
      await setSpendCap(deps.db, tenant, capUsd === null ? null : toCents(capUsd));
      await recordAudit(deps.db, tenant, {
        action: "workspace.spend_cap_set",
        targetType: "workspace",
        targetId: tenant.workspaceId,
        ...requestMeta(c),
      });
      return c.json(await spending(tenant));
    })
    .put("/llm/key", async (c) => {
      const tenant = requireAdmin(c);
      const { apiKey } = await readJson(c, setLlmKeyRequestSchema);
      await deps.vault.put(tenant, secretName, apiKey);
      await recordAudit(deps.db, tenant, {
        action: "secret.saved",
        targetType: "secret",
        targetId: secretName,
        ...requestMeta(c),
      });
      return c.json(await settings(tenant));
    })
    .delete("/llm/key", async (c) => {
      const tenant = requireAdmin(c);
      const ref = await deps.vault.find(tenant, secretName);
      if (ref) {
        await deps.vault.delete(tenant, ref);
        await recordAudit(deps.db, tenant, {
          action: "secret.deleted",
          targetType: "secret",
          targetId: secretName,
          ...requestMeta(c),
        });
      }
      return c.json(await settings(tenant));
    });
}
