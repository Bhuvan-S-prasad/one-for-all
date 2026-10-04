import { saveLoginRequestSchema, type SavedLoginList } from "@ofa/contracts";
import {
  AppError,
  ForbiddenError,
  loginSecretNames,
  loginSiteOf,
  normalizeLoginSite,
  NotFoundError,
  type TenantContext,
} from "@ofa/core";
import { recordAudit } from "@ofa/db";
import { Hono, type Context } from "hono";
import type { Container } from "../container";
import { requestMeta } from "../lib/request";
import { readJson } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Saved logins (M3.08, ADR-0012):
 *   GET    /api/logins         the sites with a saved login (never the values)
 *   PUT    /api/logins         save or replace one (owner or admin)
 *   DELETE /api/logins/:site   remove one
 *
 * Values go into the vault and come out only inside the tool executor, for
 * `use_saved_login`, which types them into that site's own pages.
 */
export function loginRoutes(deps: Pick<Container, "db" | "sessions" | "vault">) {
  function requireAdmin(c: Context<AppEnv>): TenantContext {
    const role = c.get("session").membership?.role;
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenError("Only an owner or admin can manage saved logins");
    }
    return c.get("tenant");
  }

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const secrets = await deps.vault.list(c.get("tenant"));
      const items = secrets.flatMap((s) => {
        const site = loginSiteOf(s.name);
        return site ? [{ site, updatedAt: s.updatedAt.toISOString() }] : [];
      });
      items.sort((a, b) => a.site.localeCompare(b.site));
      return c.json({ items } satisfies SavedLoginList);
    })
    .put("/", async (c) => {
      const tenant = requireAdmin(c);
      const input = await readJson(c, saveLoginRequestSchema);
      const site = normalizeLoginSite(input.site);
      if (!site)
        throw new AppError("validation_failed", "That doesn't look like a website address");
      const names = loginSecretNames(site);
      // The username is stored wrapped, so short ones meet the vault's minimum length.
      await deps.vault.put(tenant, names.username, JSON.stringify({ username: input.username }));
      await deps.vault.put(tenant, names.password, input.password);
      await recordAudit(deps.db, tenant, {
        action: "login.saved",
        targetType: "login",
        targetId: site,
        ...requestMeta(c),
      });
      return c.json({ site, updatedAt: new Date().toISOString() }, 201);
    })
    .delete("/:site", async (c) => {
      const tenant = requireAdmin(c);
      const site = normalizeLoginSite(c.req.param("site"));
      if (!site) throw new NotFoundError("Saved login");
      const names = loginSecretNames(site);
      const refs = await Promise.all([
        deps.vault.find(tenant, names.username),
        deps.vault.find(tenant, names.password),
      ]);
      if (!refs.some(Boolean)) throw new NotFoundError("Saved login");
      for (const ref of refs) if (ref) await deps.vault.delete(tenant, ref);
      await recordAudit(deps.db, tenant, {
        action: "login.deleted",
        targetType: "login",
        targetId: site,
        ...requestMeta(c),
      });
      return c.body(null, 204);
    });
}
