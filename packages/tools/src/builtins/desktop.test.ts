import { asId, SandboxError, type SandboxHandle, type SandboxProvider } from "@ofa/core";
import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "../define";
import { desktopTools } from "./desktop";

const ctx: ToolRunContext = {
  workspaceId: asId("ws"),
  userId: asId("u"),
  agentId: asId("agent-1"),
  runId: asId("run-1"),
  idempotencyKey: "run-1:4",
  tainted: true,
  memoryScopes: [],
};

function provider(openFile: SandboxHandle["openFile"]): SandboxProvider {
  const handle = { id: "fake", openFile } as unknown as SandboxHandle;
  return { acquire: async () => handle, pause: async () => {}, release: async () => {} };
}

describe("desktop.open", () => {
  it("opens the file in its app as the calling agent, and isn't outbound (ADR-0043)", async () => {
    const calls: unknown[] = [];
    const [open] = desktopTools(
      provider(async (agentId, path) => (calls.push([agentId, path]), { app: "gnumeric" })),
    );
    expect(open!.name).toBe("desktop.open");
    expect(open!.annotations).toEqual({ idempotent: true });
    const result = await open!.run({ path: "reports/laptops.xlsx" } as never, ctx);
    expect(result).toEqual({
      content: "Opened reports/laptops.xlsx in Gnumeric on your desktop.",
      untrusted: false,
    });
    expect(calls).toEqual([["agent-1", "reports/laptops.xlsx"]]);
  });

  it("passes on the computer's reason when nothing here opens the file", async () => {
    const [open] = desktopTools(
      provider(async () => {
        throw new SandboxError("bad_request", "No app on this computer opens report.pdf.");
      }),
    );
    await expect(open!.run({ path: "report.pdf" } as never, ctx)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("says so plainly when the server has no computer", async () => {
    const [open] = desktopTools(null);
    await expect(open!.run({ path: "a.txt" } as never, ctx)).rejects.toMatchObject({
      code: "not_configured",
    });
  });
});
