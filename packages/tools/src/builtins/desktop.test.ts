import {
  asId,
  SandboxError,
  type AgentDesktop,
  type SandboxHandle,
  type SandboxProvider,
} from "@ofa/core";
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

describe("desktop apps through the accessibility tree", () => {
  const shot = (clicked?: [number, number]) => ({
    data: "/9j/4AAQ",
    mediaType: "image/jpeg" as const,
    width: 1280,
    height: 800,
    title: "drawing.png - Image Viewer",
    ...(clicked ? { clicked } : {}),
  });
  function withApps(vision?: (ctx: unknown) => Promise<boolean>) {
    const calls: unknown[] = [];
    const snap = (outline: string) => ({ title: "notes.txt - Mousepad", outline });
    const apps: AgentDesktop = {
      snapshot: async () => snap("x".repeat(13_000)),
      click: async (r) => (calls.push(["click", r]), snap('[1] frame "notes.txt - Mousepad"')),
      type: async (r, text, options) => (calls.push(["type", r, text, options]), snap("typed")),
      press: async (keys) => (calls.push(["press", keys]), snap("pressed")),
      describe: async (r) => ({
        window: "notes.txt - Mousepad",
        element: r === 4 ? { role: "push button", name: "Save" } : { role: "text", name: "" },
      }),
      screenshot: async () => shot(),
      clickAt: async (x, y, options) => (calls.push(["clickAt", x, y, options]), shot([640, 240])),
      typeText: async (text, options) => (calls.push(["typeText", text, options]), shot()),
    };
    const handle = { id: "fake", desktopApps: async () => apps } as unknown as SandboxHandle;
    const sandbox: SandboxProvider = {
      acquire: async () => handle,
      pause: async () => {},
      release: async () => {},
    };
    return { tools: desktopTools(sandbox, vision as never), calls };
  }
  const byName = (tools: ReturnType<typeof desktopTools>, name: string) =>
    tools.find((t) => t.name === name)!;

  it("read the desktop as read-only and act on it as outbound (ADR-0041)", () => {
    const { tools } = withApps();
    expect(byName(tools, "desktop.snapshot").annotations).toEqual({
      readOnly: true,
      idempotent: true,
    });
    for (const name of ["desktop.click", "desktop.type", "desktop.press"]) {
      expect(byName(tools, name).annotations).toEqual({ outbound: true });
    }
  });

  it("return the desktop as untrusted text, paged like a web page", async () => {
    const { tools } = withApps();
    const first = await byName(tools, "desktop.snapshot").run({ from: 0 } as never, ctx);
    expect(first.untrusted).toBe(true);
    expect(first.content).toMatch(/^Window in front: notes\.txt - Mousepad\n\n/);
    expect(first.content).toContain("call desktop.snapshot with from: 12000 to read more");
  });

  it("pass the agent's clicks, typing and keys through, and say what they'd do", async () => {
    const { tools, calls } = withApps();
    await byName(tools, "desktop.click").run({ ref: 4 } as never, ctx);
    await byName(tools, "desktop.type").run(
      { ref: 2, text: "hello", clear: true, submit: false } as never,
      ctx,
    );
    await byName(tools, "desktop.press").run({ keys: "ctrl+s" } as never, ctx);
    expect(calls).toEqual([
      ["click", 4],
      ["type", 2, "hello", { clear: true, submit: false }],
      ["press", "ctrl+s"],
    ]);
    const click = byName(tools, "desktop.click");
    expect(await click.describe!({ ref: 4 } as never, ctx)).toBe(
      "Click the push button “Save” in “notes.txt - Mousepad”",
    );
    const type = byName(tools, "desktop.type");
    expect(
      await type.describe!({ ref: 2, text: "hi", clear: false, submit: true } as never, ctx),
    ).toBe("Type “hi” into the text in “notes.txt - Mousepad”, then press Enter");
  });

  it("refuse keys that aren't keys", () => {
    const { tools } = withApps();
    const input = byName(tools, "desktop.press").input;
    expect(input.safeParse({ keys: "ctrl+s Return" }).success).toBe(true);
    expect(input.safeParse({ keys: "$(rm -rf ~)" }).success).toBe(false);
  });
});

describe("the screenshot fallback (DT.11)", () => {
  // Reuses the fake from above through a small copy, so the tests stay apart.
  const shot = {
    data: "/9j/4AAQ",
    mediaType: "image/jpeg" as const,
    width: 1280,
    height: 800,
    title: "drawing.png - Image Viewer",
  };
  function tools(vision?: boolean) {
    const calls: unknown[] = [];
    const apps = {
      screenshot: async () => shot,
      clickAt: async (x: number, y: number, o: unknown) => (
        calls.push(["clickAt", x, y, o]),
        { ...shot, clicked: [640, 240] as const }
      ),
      typeText: async (t: string, o: unknown) => (calls.push(["typeText", t, o]), shot),
    };
    const handle = { id: "fake", desktopApps: async () => apps } as unknown as SandboxHandle;
    const sandbox: SandboxProvider = {
      acquire: async () => handle,
      pause: async () => {},
      release: async () => {},
    };
    const list = desktopTools(sandbox, vision === undefined ? undefined : async () => vision);
    return { list, calls, get: (name: string) => list.find((t) => t.name === name)! };
  }

  it("is listed only when the run's model can see images", async () => {
    for (const name of ["desktop.screenshot", "desktop.click_at", "desktop.type_text"]) {
      expect(await tools().get(name).listed!(ctx)).toBeNull();
      expect(await tools(false).get(name).listed!(ctx)).toBeNull();
      expect((await tools(true).get(name).listed!(ctx))?.description).toBeTruthy();
    }
    // The tree tools are always listed (they don't depend on images).
    expect(tools(false).get("desktop.snapshot").listed).toBeUndefined();
  });

  it("shows the model the screen with the result, as outside content", async () => {
    const { get } = tools(true);
    expect(get("desktop.screenshot").annotations).toEqual({ readOnly: true, idempotent: true });
    const result = await get("desktop.screenshot").run({} as never, ctx);
    expect(result).toMatchObject({
      untrusted: true,
      image: { data: "/9j/4AAQ", mediaType: "image/jpeg" },
    });
    expect(result.content).toContain("Window in front: drawing.png - Image Viewer");
  });

  it("clicks at fractions of the screen, and types, as outbound actions", async () => {
    const { get, calls } = tools(true);
    expect(get("desktop.click_at").annotations).toEqual({ outbound: true });
    expect(get("desktop.type_text").annotations).toEqual({ outbound: true });
    const clicked = await get("desktop.click_at").run(
      { x: 0.5, y: 0.3, double: false } as never,
      ctx,
    );
    expect(clicked.content).toMatch(/^Clicked at pixel \(640, 240\)\./);
    await get("desktop.type_text").run({ text: "hello", submit: true } as never, ctx);
    expect(calls).toEqual([
      ["clickAt", 0.5, 0.3, { double: false }],
      ["typeText", "hello", { submit: true }],
    ]);
    expect(
      await get("desktop.click_at").describe!({ x: 0.5, y: 0.3, double: true } as never, ctx),
    ).toBe("Double-click on its desktop at 50% across, 30% down");
  });
});
