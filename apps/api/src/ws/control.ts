import type { WSContext } from "hono/ws";

/**
 * Who has control of each agent's computer (M3.07, ADR-0040), through the
 * browser view or the desktop view: one person at a time, across both.
 * Control belongs to a person, not a socket: when the same person takes
 * control from a newer window (or the page remounts), it moves there and the
 * older socket is closed with 4002. Another person is refused.
 */
export class ComputerControl {
  private readonly holders = new Map<string, { ws: WSContext; userId: string }>();

  /** Take control for this socket; false if another person has it. */
  claim(agentId: string, userId: string, ws: WSContext): boolean {
    const current = this.holders.get(agentId);
    if (current && current.userId !== userId) return false;
    if (current && current.ws !== ws) current.ws.close(4002, "You took control in another window.");
    this.holders.set(agentId, { ws, userId });
    return true;
  }

  /** Let go. True if this socket still had control, so the computer goes back to the agent. */
  release(agentId: string, ws: WSContext): boolean {
    if (this.holders.get(agentId)?.ws !== ws) return false;
    this.holders.delete(agentId);
    return true;
  }

  /** Whether someone other than this person has control. */
  heldByOther(agentId: string, userId: string): boolean {
    const current = this.holders.get(agentId);
    return current !== undefined && current.userId !== userId;
  }
}
