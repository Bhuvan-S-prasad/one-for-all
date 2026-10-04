import { setLlmKeyRequestSchema, type LlmSettings, type UsageToday } from "@ofa/contracts";
import { ForbiddenError, MODEL_TIERS, type TenantContext } from "@ofa/core";
import { modelCallsSince, recordAudit } from "@ofa/db";
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
 */
export function settingsRoutes(
  deps: Pick<Container, "db" | "sessions" | "vault" | "llmProvider" | "tiers" | "config">,
) {
  const provider = deps.llmProvider;
  const secretName = llmKeySecretName(provider.id);

  function requireAdmin(c: Context<AppEnv>): TenantContext {
    const role = c.get("session").membership?.role;
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenError("Only an owner or admin can change the model key");
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

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/llm", async (c) => c.json(await settings(c.get("tenant"))))
    .get("/usage", async (c) => c.json(await usage(c.get("tenant"))))
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
