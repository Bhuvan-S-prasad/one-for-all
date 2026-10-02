import type { RealtimeMessage } from "@ofa/contracts";
import type { TenantContext } from "@ofa/core";
import { getAgent, getMessage, getRun, getRunEvent } from "@ofa/db";
import { busPayloadSchema, workspaceTopic } from "@ofa/events";
import type { UpgradeWebSocket } from "hono/ws";
import type { Container } from "../container";
import { toAgent, toMessage, toRun, toRunEvent } from "../lib/mappers";

// Realtime gateway (ARCHITECTURE.md §17, `ws/`). A signed-in socket receives
// its workspace's activity: run events, run status, new messages, agent edits.
// Bus events carry IDs (ADR-0007); the gateway loads each row with the
// socket's own tenant context, so row-level security still applies.

const PING_MS = 25_000;

async function toRealtime(
  deps: Pick<Container, "db">,
  tenant: TenantContext,
  raw: unknown,
): Promise<RealtimeMessage | null> {
  const parsed = busPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const payload = parsed.data;
  switch (payload.kind) {
    case "run.event": {
      const row = await getRunEvent(deps.db, tenant, payload.runId, payload.seq);
      const event = row ? toRunEvent(row) : null;
      return event ? { type: "run.event", event } : null;
    }
    case "run.updated": {
      const run = await getRun(deps.db, tenant, payload.runId);
      return run ? { type: "run.updated", run: toRun(run) } : null;
    }
    case "message.created": {
      const message = await getMessage(deps.db, tenant, payload.messageId);
      return message ? { type: "message.created", message: toMessage(message) } : null;
    }
    case "agent.updated": {
      const agent = await getAgent(deps.db, tenant, payload.agentId);
      return agent ? { type: "agent.updated", agent: toAgent(agent) } : null;
    }
  }
}

/** The `/api/ws` handler. Runs after the session and tenant middleware. */
export function realtimeHandler(
  deps: Pick<Container, "db" | "bus" | "logger">,
  upgrade: UpgradeWebSocket,
) {
  return upgrade((c) => {
    const tenant = c.get("tenant") as TenantContext;
    let unsubscribe: (() => Promise<void>) | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    return {
      async onOpen(_event, ws) {
        unsubscribe = await deps.bus.subscribe(
          workspaceTopic(tenant.workspaceId),
          async (event) => {
            if (closed) return;
            try {
              const message = await toRealtime(deps, tenant, event.payload);
              if (message && !closed) ws.send(JSON.stringify(message));
            } catch (error) {
              deps.logger.warn("realtime event dropped", { error });
            }
          },
        );
        if (closed) {
          await unsubscribe();
          return;
        }
        ping = setInterval(() => ws.send(JSON.stringify({ type: "ready" })), PING_MS);
        ws.send(JSON.stringify({ type: "ready" } satisfies RealtimeMessage));
      },
      onMessage() {
        // Server-to-client only: actions go through the REST API and its checks.
      },
      async onClose() {
        closed = true;
        if (ping) clearInterval(ping);
        await unsubscribe?.();
      },
    };
  });
}
