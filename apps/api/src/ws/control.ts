import type { WSContext } from "hono/ws";

/**
 * Who has control of each agent's computer (M3.07, ADR-0040): agent ID → the
 * socket in control, through the browser view or the desktop view. One
 * person at a time, across both.
 */
export type ComputerControl = Map<string, WSContext>;

export function computerControl(): ComputerControl {
  return new Map();
}
