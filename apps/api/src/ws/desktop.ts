import { asId, type AgentId, type DesktopStream, type TenantContext } from "@ofa/core";
import { getAgent, recordAudit } from "@ofa/db";
import type { UpgradeWebSocket } from "hono/ws";
import type { Container } from "../container";
import type { ComputerControl } from "./control";

// Watching and taking over an agent's desktop (ADR-0040):
//   GET /api/agents/:id/desktop            watch the whole screen
//   GET /api/agents/:id/desktop?control=1  take over: the person's mouse and
//                                          keyboard reach the desktop too
//
// The socket carries the VNC (RFB) stream as binary messages, both ways, for
// the web app's VNC client; nothing else is mixed in. The same login and
// Origin checks as /api/ws. One person controls a computer at a time, here
// or in the browser view; while they do, the agent's computer tools are
// refused. Control ends when the socket closes. Nothing is decoded or kept.
//
// Close codes the client acts on:
//   4001  someone else has control: watch instead
//   4002  this person took control in another window
//   4004  no such agent, or no computer on this server
//   4500  the view could not start (the reason says why)

/** A viewer this far behind is cut off rather than buffered without limit. */
const MAX_BUFFERED = 32 * 1024 * 1024;

export function desktopHandler(
  deps: Pick<Container, "db" | "sandbox" | "logger">,
  upgrade: UpgradeWebSocket,
  controllers: ComputerControl,
) {
  return upgrade((c) => {
    const tenant = c.get("tenant") as TenantContext;
    const agentId = asId<AgentId>(c.req.param("id") ?? "");
    const wantsControl = c.req.query("control") === "1";
    let stream: DesktopStream | undefined;
    let control = false;
    let closed = false;
    const audit = (action: string) =>
      recordAudit(deps.db, tenant, { action, targetType: "agent", targetId: agentId }).catch(
        (error) => deps.logger.warn("audit failed", { error }),
      );

    return {
      async onOpen(_event, ws) {
        try {
          if (!deps.sandbox) return ws.close(4004, "This server has no computer for agents.");
          const agent = await getAgent(deps.db, tenant, agentId);
          if (!agent) return ws.close(4004, "No such agent.");
          if (wantsControl && !controllers.claim(agentId, tenant.userId, ws)) {
            return ws.close(4001, "Someone else has control of this computer. You can watch.");
          }
          const handle = await deps.sandbox.acquire(tenant);
          if (wantsControl) {
            control = true;
            await handle.takeover(agentId, true);
            await audit("computer.takeover_started");
          }
          stream = await handle.desktop(agentId, { control });
          if (closed) return stream.close();
          stream.onData((chunk) => {
            const buffered =
              (ws.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount ?? 0;
            if (buffered > MAX_BUFFERED) return ws.close(4500, "The view fell too far behind.");
            ws.send(chunk);
          });
          stream.onEnd((reason) => {
            if (!closed) ws.close(1000, reason.slice(0, 120));
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Couldn't open the desktop.";
          ws.close(4500, reason.slice(0, 120));
        }
      },

      onMessage(event) {
        // Watchers send messages too (the VNC handshake, screen update
        // requests); the computer ignores a watcher's mouse and keyboard.
        const data = event.data;
        if (typeof data === "string") return;
        if (data instanceof ArrayBuffer) stream?.send(new Uint8Array(data));
        else if (ArrayBuffer.isView(data)) {
          stream?.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
      },

      async onClose(_event, ws) {
        closed = true;
        stream?.close();
        // Hand back only if control didn't move to a newer window of this person.
        if (control && controllers.release(agentId, ws)) {
          try {
            await (await deps.sandbox?.acquire(tenant))?.takeover(agentId, false);
          } catch (error) {
            deps.logger.warn("could not hand the computer back", { error, agentId });
          }
          await audit("computer.takeover_ended");
        }
      },
    };
  });
}
