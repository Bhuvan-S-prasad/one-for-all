import { setLlmKeyRequestSchema, type LlmSettings } from "@ofa/contracts";
import { ForbiddenError, MODEL_TIERS, type TenantContext } from "@ofa/core";
import { recordAudit } from "@ofa/db";
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

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/llm", async (c) => c.json(await settings(c.get("tenant"))))
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
