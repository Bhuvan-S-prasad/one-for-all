import {
  asId,
  type AgentBrowser,
  type PageSnapshot,
  type SandboxHandle,
  type SandboxProvider,
} from "@ofa/core";
import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "../define";
import { browserTools, fileTools, pageText, shellTool, useSavedLoginTool } from "./computer";

const ctx: ToolRunContext = {
  workspaceId: asId("ws"),
  userId: asId("u"),
  agentId: asId("agent-1"),
  runId: asId("run-1"),
  idempotencyKey: "run-1:3",
  tainted: false,
  memoryScopes: [],
};

const page = (outline: string): PageSnapshot => ({
  url: "https://a.example/",
  title: "A",
  outline,
});

/** A fake computer that records what it was asked. */
function fakeSandbox(overrides: Partial<SandboxHandle> = {}) {
  const calls: unknown[][] = [];
  const browser: AgentBrowser = {
    open: async (url) => (calls.push(["open", url]), page('[7] link "Next"')),
    snapshot: async () => page("x".repeat(7_000)),
    click: async (ref) => (calls.push(["click", ref]), page("clicked")),
    type: async (ref, text, options) => (calls.push(["type", ref, text, options]), page("typed")),
    press: async (key) => (calls.push(["press", key]), page("pressed")),
    back: async () => page("back"),
    describe: async (ref) => ({
      url: "https://a.example/cart",
      title: "Cart",
      ...(ref === 9 ? { element: { role: "button", name: "Pay   now" } } : {}),
    }),
  };
  const handle: SandboxHandle = {
    id: "fake",
    exec: async (agentId, command, options) => {
      calls.push(["exec", agentId, command, options]);
      return {
        exitCode: 2,
        stdout: `${"a".repeat(9_000)}END`,
        stderr: "warn",
        truncated: false,
        timedOut: false,
      };
    },
    readFile: async () => new TextEncoder().encode("hello"),
    writeFile: async (...args) => void calls.push(["write", ...args]),
    listFiles: async () => ({
      entries: [
        { name: "b.txt", type: "file", size: 1200, modifiedAt: "2026-10-04T10:00:00.000Z" },
        { name: "data", type: "directory", size: 0, modifiedAt: "2026-10-04T10:00:00.000Z" },
      ],
      truncated: false,
    }),
    browser: async () => browser,
    shareLogin: async () => ({ cookies: 0 }),
    screen: async () => {
      throw new Error("no screen in tests");
    },
    takeover: async () => {},
    restart: async () => {},
    health: async () => ({ ok: true }),
    ...overrides,
  };
  const provider: SandboxProvider = {
    acquire: async () => handle,
    pause: async () => {},
    release: async () => {},
  };
  return { provider, calls };
}

const byName = <T extends { name: string }>(list: T[], name: string) =>
  list.find((t) => t.name === name)!;

describe("computer tools", () => {
  it("say so plainly when the server has no computer", async () => {
    await expect(
      shellTool(null).run({ command: "ls", timeout_seconds: 60 }, ctx),
    ).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("mark acting on sites and the shell as outbound, reading as read-only", () => {
    const tools = [...browserTools(null), shellTool(null), ...fileTools(null)];
    const outbound = tools.filter((t) => t.annotations.outbound).map((t) => t.name);
    expect(outbound.sort()).toEqual([
      "browser.click",
      "browser.press",
      "browser.type",
      "shell.run",
    ]);
    for (const name of ["browser.open", "browser.snapshot", "files.read", "files.list"]) {
      expect(byName(tools, name).annotations.readOnly).toBe(true);
    }
  });

  it("run the browser as the calling agent and return the page as untrusted text", async () => {
    const { provider, calls } = fakeSandbox();
    const tools = browserTools(provider);
    const opened = await byName(tools, "browser.open").run(
      { url: "https://a.example/" } as never,
      ctx,
    );
    expect(opened).toEqual({
      content: 'Page: A\nURL: https://a.example/\n\n[7] link "Next"',
      untrusted: true,
    });
    await byName(tools, "browser.type").run(
      { ref: 7, text: "hi", clear: true, submit: true } as never,
      ctx,
    );
    expect(calls).toContainEqual(["type", 7, "hi", { clear: true, submit: true }]);
  });

  it("say in plain words what a held call would do, for the approval card", async () => {
    const { provider, calls } = fakeSandbox();
    const tools = browserTools(provider);
    const describe = (name: string, args: unknown) =>
      byName(tools, name).describe!(args as never, ctx);
    expect(await describe("browser.click", { ref: 9 })).toBe(
      "Click the button “Pay now” on a.example",
    );
    expect(await describe("browser.type", { ref: 4, text: "Sam", submit: true })).toBe(
      "Type “Sam” into element [4] on a.example, then press Enter",
    );
    expect(await describe("browser.press", { key: "Enter" })).toBe("Press Enter on a.example");
    expect(
      await shellTool(provider).describe!({ command: "rm -rf build", timeout_seconds: 60 }, ctx),
    ).toBe("Run a command on its computer:\nrm -rf build");
    // Describing changes nothing.
    expect(calls).toEqual([]);
  });

  it("page long snapshots like web.read_url", () => {
    const text = pageText(page("x".repeat(7_000)));
    expect(text).toContain("call browser.snapshot with from: 6000");
    expect(pageText(page("x".repeat(7_000)), 6_000)).not.toContain("call browser.snapshot");
  });

  it("run commands as the agent and keep the end of long output", async () => {
    const { provider, calls } = fakeSandbox();
    const result = await shellTool(provider).run({ command: "make", timeout_seconds: 30 }, ctx);
    expect(calls[0]).toEqual(["exec", "agent-1", "make", { cwd: undefined, timeoutMs: 30_000 }]);
    const content = result.content as string;
    expect(content.startsWith("Exit code 2.")).toBe(true);
    expect(content).toContain("earlier characters cut");
    expect(content).toContain("END");
    expect(content).toContain("stderr:\nwarn");
    expect(result.untrusted).toBe(true);
  });

  it("read, write and list files", async () => {
    const { provider, calls } = fakeSandbox();
    const files = fileTools(provider);
    expect(
      (await byName(files, "files.read").run({ path: "a.txt", from: 0 } as never, ctx)).content,
    ).toBe("hello");
    const written = await byName(files, "files.write").run(
      { path: "notes/a.md", content: "é" } as never,
      ctx,
    );
    expect(written).toEqual({ content: "Wrote notes/a.md (2 bytes).", untrusted: false });
    expect(calls).toContainEqual(["write", "agent-1", "notes/a.md", "é"]);
    expect((await byName(files, "files.list").run({ path: "." } as never, ctx)).content).toBe(
      "data/\nb.txt  1,200 B  2026-10-04 10:00",
    );
  });

  it("don't dump binary files on the model", async () => {
    const { provider } = fakeSandbox({ readFile: async () => new Uint8Array([0x89, 0x50, 0, 1]) });
    const result = await byName(fileTools(provider), "files.read").run(
      { path: "a.png", from: 0 } as never,
      ctx,
    );
    expect(result.content).toBe("a.png is a binary file (4 bytes); it can't be shown as text.");
  });
});

describe("use_saved_login", () => {
  const saved = { username: "sam@example.com", password: "correct-horse-battery" };
  const at = (url: string, typedEcho = false) => {
    const typed: unknown[] = [];
    const { provider } = fakeSandbox({
      browser: async () => ({
        open: async () => ({ url, title: "", outline: "" }),
        snapshot: async () => ({
          url,
          title: "Sign in",
          outline: '[3] textbox "Email"\n[4] textbox "Password"',
        }),
        click: async () => ({ url, title: "", outline: "" }),
        type: async (ref, text, options) => {
          typed.push([ref, text, options]);
          return {
            url,
            title: "Signed in",
            outline: typedEcho ? `Welcome ${saved.username} ${saved.password}` : "Welcome",
          };
        },
        press: async () => ({ url, title: "", outline: "" }),
        back: async () => ({ url, title: "", outline: "" }),
        describe: async () => ({ url, title: "Sign in" }),
      }),
    });
    const lookups: string[] = [];
    const runCtx: ToolRunContext = {
      ...ctx,
      logins: {
        get: async (site) => {
          lookups.push(site);
          return site === "example.com" ? saved : null;
        },
      },
    };
    return { tool: useSavedLoginTool(provider), runCtx, typed, lookups };
  };

  it("types the saved login on the site's own pages, and never hands the values back", async () => {
    const { tool, runCtx, typed, lookups } = at("https://login.example.com/signin", true);
    const result = await tool.run({ username_ref: 3, password_ref: 4, submit: true }, runCtx);
    expect(lookups).toEqual(["login.example.com", "example.com"]);
    expect(typed).toEqual([
      [3, saved.username, { clear: true }],
      [4, saved.password, { clear: true, submit: true }],
    ]);
    const content = result.content as string;
    expect(content).toContain("Typed the saved login for example.com.");
    expect(content).not.toContain(saved.password);
    expect(content).not.toContain(saved.username);
    expect(tool.annotations.outbound).toBe(true);
  });

  it("refuses look-alike sites and pages without a saved login", async () => {
    for (const url of ["https://example.com.evil.test/login", "about:blank"]) {
      const { tool, runCtx, typed } = at(url);
      await expect(tool.run({ password_ref: 4, submit: true }, runCtx)).rejects.toMatchObject({
        code: "no_saved_login",
      });
      expect(typed).toEqual([]);
    }
  });
});
