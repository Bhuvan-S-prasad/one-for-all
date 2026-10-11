import type { WSContext } from "hono/ws";
import { describe, expect, it, vi } from "vitest";
import { ComputerControl } from "./control";

const socket = () =>
  ({ close: vi.fn() }) as unknown as WSContext & { close: ReturnType<typeof vi.fn> };

describe("ComputerControl", () => {
  it("gives control to one person at a time", () => {
    const control = new ComputerControl();
    const mine = socket();
    expect(control.claim("agent-1", "user-1", mine)).toBe(true);
    expect(control.claim("agent-1", "user-2", socket())).toBe(false);
    expect(control.heldByOther("agent-1", "user-2")).toBe(true);
    expect(control.heldByOther("agent-1", "user-1")).toBe(false);
    expect(control.claim("agent-2", "user-2", socket())).toBe(true); // Another agent is free.
    expect(mine.close).not.toHaveBeenCalled();
  });

  it("moves control to the same person's newer window, and only the holder hands back", () => {
    const control = new ComputerControl();
    const first = socket();
    const second = socket();
    control.claim("agent-1", "user-1", first);
    expect(control.claim("agent-1", "user-1", second)).toBe(true);
    expect(first.close).toHaveBeenCalledWith(4002, "You took control in another window.");
    // The older socket closing must not hand the computer back to the agent.
    expect(control.release("agent-1", first)).toBe(false);
    expect(control.release("agent-1", second)).toBe(true);
    expect(control.heldByOther("agent-1", "user-2")).toBe(false);
  });
});
