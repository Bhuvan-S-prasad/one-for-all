import { screenInputSchema, type ScreenMessage } from "@ofa/contracts";
import { asId, type AgentId, type ScreenSession, type TenantContext } from "@ofa/core";
import { getAgent, recordAudit } from "@ofa/db";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { Container } from "../container";
import type { ComputerControl } from "./control";

// Watching and taking over an agent's browser (M3.07, ADR-0025):
//   GET /api/agents/:id/screen            watch (frames only)
//   GET /api/agents/:id/screen?control=1  take over: frames, plus the person's
//                                         mouse and keyboard
//
// The same login and Origin checks as /api/ws. One person controls a browser
// at a time; while they do, the agent's browser tools are refused. Control
// ends when the socket closes. Frames are sent on and never stored; what the
// person types (a password, say) goes to the page and nowhere else.

/** Frames waiting to be sent past this are dropped rather than queued. */
const MAX_BUFFERED = 2 * 1024 * 1024;

export function screenHandler(
  deps: Pick<Container, "db" | "sandbox" | "logger">,
  upgrade: UpgradeWebSocket,
  controllers: ComputerControl,
) {
  return upgrade((c) => {
    const tenant = c.get("tenant") as TenantContext;
    const agentId = asId<AgentId>(c.req.param("id") ?? "");
    const wantsControl = c.req.query("control") === "1";
    let session: ScreenSession | undefined;
    let control = false;
    let closed = false;
    const send = (ws: WSContext, message: ScreenMessage) => {
      if (!closed) ws.send(JSON.stringify(message));
    };
    const audit = (action: string) =>
      recordAudit(deps.db, tenant, { action, targetType: "agent", targetId: agentId }).catch(
        (error) => deps.logger.warn("audit failed", { error }),
      );

    return {
      async onOpen(_event, ws) {
        try {
          if (!deps.sandbox) throw new Error("This server has no computer for agents.");
          const agent = await getAgent(deps.db, tenant, agentId);
          if (!agent) throw new Error("No such agent.");
          const handle = await deps.sandbox.acquire(tenant);

          if (wantsControl && controllers.claim(agentId, tenant.userId, ws)) {
            control = true;
            await handle.takeover(agentId, true);
            await audit("computer.takeover_started");
          }
          session = await handle.screen(agentId);
          if (closed) return session.close();
          session.onFrame((frame) => {
            const buffered =
              (ws.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount ?? 0;
            if (buffered > MAX_BUFFERED) return; // A slow viewer skips frames.
            send(ws, { type: "frame", ...frame });
          });
          session.onEnd((reason) => {
            send(ws, { type: "end", reason });
            ws.close();
          });
          send(ws, {
            type: "status",
            control,
            takenOverByOther: !control && controllers.heldByOther(agentId, tenant.userId),
          });
        } catch (error) {
          send(ws, {
            type: "error",
            message: error instanceof Error ? error.message : "Couldn't open the screen.",
          });
          ws.close();
        }
      },

      async onMessage(event, ws) {
        // Only the person in control may act; a viewer's messages are ignored.
        if (!control || !session) return;
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = screenInputSchema.safeParse(raw);
        if (!parsed.success) return;
        try {
          await session.input(parsed.data);
        } catch (error) {
          send(ws, {
            type: "error",
            message: error instanceof Error ? error.message : "That didn't work.",
          });
        }
      },

      async onClose(_event, ws) {
        closed = true;
        session?.close();
        // Hand back only if control didn't move to a newer window of this person.
        if (control && controllers.release(agentId, ws)) {
          try {
            await (await deps.sandbox?.acquire(tenant))?.takeover(agentId, false);
          } catch (error) {
            deps.logger.warn("could not hand the browser back", { error, agentId });
          }
          await audit("computer.takeover_ended");
        }
      },
    };
  });
}
