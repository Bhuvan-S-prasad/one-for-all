import {
  createAgentRequestSchema,
  toAgentSlug,
  updateAgentRequestSchema,
  type AgentListResponse,
} from "@ofa/contracts";
import { NotFoundError } from "@ofa/core";
import { workspaceEvent } from "@ofa/events";
import { createAgent, directThread, getAgent, listAgents, recordAudit, updateAgent } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toAgent, toThread } from "../lib/mappers";
import { requestMeta } from "../lib/request";
import { readJson } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Agents (M2.19):
 *   GET   /api/agents             list (not archived)
 *   POST  /api/agents             hatch an agent
 *   GET   /api/agents/:id
 *   PATCH /api/agents/:id         edit, pause, archive
 *   GET   /api/agents/:id/thread  the person's direct thread with it (created on first use)
 */
export function agentRoutes(deps: Pick<Container, "db" | "sessions" | "bus">) {
  const { db } = deps;
  const announce = (workspaceId: string, agentId: string) =>
    deps.bus
      .publish(workspaceEvent(workspaceId, { kind: "agent.updated", agentId }))
      .catch(() => {});

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const items = await listAgents(db, c.get("tenant"));
      return c.json({ items: items.map(toAgent) } satisfies AgentListResponse);
    })
    .post("/", async (c) => {
      const tenant = c.get("tenant");
      const input = await readJson(c, createAgentRequestSchema);
      const agent = await createAgent(db, tenant, {
        ...input,
        slug: input.slug ?? toAgentSlug(input.name),
      });
      await recordAudit(db, tenant, {
        action: "agent.created",
        targetType: "agent",
        targetId: agent.id,
        data: { name: agent.name, grants: input.grants },
        ...requestMeta(c),
      });
      await announce(tenant.workspaceId, agent.id);
      return c.json(toAgent(agent), 201);
    })
    .get("/:id", async (c) => {
      const agent = await getAgent(db, c.get("tenant"), c.req.param("id"));
      if (!agent) throw new NotFoundError("Agent");
      return c.json(toAgent(agent));
    })
    .patch("/:id", async (c) => {
      const tenant = c.get("tenant");
      const patch = await readJson(c, updateAgentRequestSchema);
      const agent = await updateAgent(db, tenant, c.req.param("id"), patch);
      if (!agent) throw new NotFoundError("Agent");
      if (patch.grants || patch.status) {
        // Permission changes are security-relevant (ARCHITECTURE.md §15, audit_log).
        await recordAudit(db, tenant, {
          action: "agent.updated",
          targetType: "agent",
          targetId: agent.id,
          data: {
            ...(patch.grants ? { grants: patch.grants } : {}),
            ...(patch.status ? { status: patch.status } : {}),
          },
          ...requestMeta(c),
        });
      }
      await announce(tenant.workspaceId, agent.id);
      return c.json(toAgent(agent));
    })
    .get("/:id/thread", async (c) => {
      const tenant = c.get("tenant");
      const agent = await getAgent(db, tenant, c.req.param("id"));
      if (!agent) throw new NotFoundError("Agent");
      return c.json(toThread(await directThread(db, tenant, agent.id)));
    });
}
