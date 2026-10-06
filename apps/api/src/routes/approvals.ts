import {
  approvalListQuerySchema,
  decideApprovalRequestSchema,
  type Approval,
  type ApprovalList,
} from "@ofa/contracts";
import { AppError, ForbiddenError, NotFoundError, type ApprovalRecord } from "@ofa/core";
import { getRun, recordAudit } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { requestMeta } from "../lib/request";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Approvals (ARCHITECTURE.md §6.2), pulled forward from M4 for M3.13:
 *   GET  /api/approvals       waiting for an answer (?agentId=&runId=)
 *   GET  /api/approvals/:id
 *   POST /api/approvals/:id   { decision: approve | reject, scope?: once | site }
 *
 * The person who started the run answers, or an owner or admin. The row is
 * settled first (only while pending, so two answers cannot both win), then
 * the waiting run is woken. Every answer is audited.
 */
export function approvalRoutes(
  deps: Pick<Container, "db" | "sessions" | "approvals" | "dispatcher" | "logger">,
) {
  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const filter = readQuery(c, approvalListQuerySchema);
      const items = await deps.approvals.listPending(c.get("tenant"), filter);
      return c.json({ items: items.map(toApproval) } satisfies ApprovalList);
    })
    .get("/:id", async (c) => {
      const found = await deps.approvals.get(c.get("tenant"), c.req.param("id"));
      if (!found) throw new NotFoundError("Approval");
      return c.json(toApproval(found));
    })
    .post("/:id", async (c) => {
      const tenant = c.get("tenant");
      const session = c.get("session");
      const { decision, scope } = await readJson(c, decideApprovalRequestSchema);
      const found = await deps.approvals.get(tenant, c.req.param("id"));
      if (!found) throw new NotFoundError("Approval");
      const run = await getRun(deps.db, tenant, found.runId);
      const role = session.membership?.role;
      if (run?.triggeredBy !== tenant.userId && role !== "owner" && role !== "admin") {
        throw new ForbiddenError(
          "Only the person who asked, or an owner or admin, can answer this",
        );
      }
      if (scope === "site" && (decision !== "approve" || !found.site)) {
        throw new AppError(
          "validation_failed",
          "Only an approval that names a site can be approved for that site",
        );
      }
      const status = decision === "approve" ? "approved" : "rejected";
      const decided = await deps.approvals.decide(tenant, found.id, {
        status,
        decidedBy: tenant.userId,
        scope,
      });
      if (!decided) {
        throw new AppError(
          "conflict",
          found.status === "expired" ? "This request expired" : "This was already answered",
        );
      }
      await recordAudit(deps.db, tenant, {
        action: `approval.${status}`,
        targetType: "approval",
        targetId: found.id,
        data: {
          tool: found.tool,
          runId: found.runId,
          agentId: found.agentId,
          ...(scope === "site" ? { allowedSite: found.site } : {}),
        },
        ...requestMeta(c),
      });
      await deps.dispatcher.approvalDecided({
        workspaceId: tenant.workspaceId,
        userId: tenant.userId,
        approvalId: found.id,
        runId: found.runId,
        decision: status,
      });
      return c.json(toApproval(decided));
    });
}

export function toApproval(row: ApprovalRecord): Approval {
  return {
    ...row,
    reasons: [...row.reasons],
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
