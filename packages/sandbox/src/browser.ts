import { SandboxError, type AgentBrowser, type PageSnapshot } from "@ofa/core";
import { connectCdp, type CdpConnection } from "./cdp";
import { outlineFromAXTree, titleFromAXTree, type AXNode } from "./snapshot";

// One agent's browser over CDP (M3.04). Each call connects, works on the
// agent's current tab (opening one if there is none), returns the page as an
// outline from the accessibility tree, and disconnects: nothing is held
// between tool calls, so a retried step or a restarted process just works.

const LOAD_TIMEOUT = 20_000;
/** After a click or key: long enough for a navigation to start. */
const SETTLE_MS = 700;

interface Page {
  readonly cdp: CdpConnection;
  readonly session: string;
}

/** Keys the agent can press, as CDP key events need them. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
};
export const BROWSER_KEYS = Object.keys(KEYS);

/**
 * Attach to the agent's current tab (the last one opened), opening one if
 * there is none. Chromium's own pages (chrome://, devtools://) don't count.
 * A tab can be swapped out just as the browser starts ("Not attached to an
 * active page"), so on that error the tabs are listed again, once.
 */
export async function attachToTab(cdp: CdpConnection): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { targetInfos } = await cdp.send<{
        targetInfos: { targetId: string; type: string; url: string }[];
      }>("Target.getTargets");
      const tabs = targetInfos.filter(
        (t) => t.type === "page" && !/^(chrome|devtools):/.test(t.url),
      );
      const targetId =
        tabs.at(-1)?.targetId ??
        (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }))
          .targetId;
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await cdp.send("Page.enable", {}, sessionId);
      return sessionId;
    } catch (error) {
      const gone = error instanceof Error && /not attached|no target/i.test(error.message);
      if (!gone || attempt >= 1) throw error;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** The agent's browser, given the WebSocket address of its CDP endpoint. */
export function createCdpBrowser(endpoint: () => Promise<string>): AgentBrowser {
  async function withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    const cdp = await connectCdp(await endpoint());
    try {
      return await work({ cdp, session: await attachToTab(cdp) });
    } finally {
      cdp.close();
    }
  }

  async function snapshotOf({ cdp, session }: Page): Promise<PageSnapshot> {
    const [{ nodes }, history] = await Promise.all([
      cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}, session),
      cdp.send<{ currentIndex: number; entries: { url: string; title: string }[] }>(
        "Page.getNavigationHistory",
        {},
        session,
      ),
    ]);
    const current = history.entries[history.currentIndex];
    let outline = outlineFromAXTree(nodes);
    if (!outline) {
      // A slow site can outlast the load wait: say so, rather than "empty".
      const { result } = await cdp.send<{ result: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        session,
      );
      outline =
        result.value === "complete"
          ? "(The page is empty.)"
          : "(The page is still loading. Take another snapshot in a moment.)";
    }
    return {
      url: current?.url ?? "",
      title: titleFromAXTree(nodes) || current?.title || "",
      outline,
    };
  }

  /**
   * Listen before acting, then wait: if the action starts a navigation within
   * a moment, wait for the new page to load; otherwise carry on. Listening
   * first means a fast page cannot load before anyone is watching.
   */
  async function act(page: Page, action: () => Promise<void>): Promise<void> {
    const { cdp, session } = page;
    const started = cdp.next("Page.frameStartedLoading", {
      sessionId: session,
      timeoutMs: SETTLE_MS,
    });
    const loaded = cdp.next("Page.loadEventFired", { sessionId: session, timeoutMs: LOAD_TIMEOUT });
    await action();
    if ((await started) !== null) {
      await loaded;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** The middle of an element, scrolled into view; fails clearly for a stale number. */
  async function centre({ cdp, session }: Page, ref: number): Promise<{ x: number; y: number }> {
    try {
      await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref }, session);
      const { quads } = await cdp.send<{ quads: number[][] }>(
        "DOM.getContentQuads",
        { backendNodeId: ref },
        session,
      );
      const quad = quads[0];
      if (!quad) throw new Error("not visible");
      const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
      const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
      return {
        x: xs.reduce((a, b) => a + b, 0) / 4,
        y: ys.reduce((a, b) => a + b, 0) / 4,
      };
    } catch {
      throw new SandboxError(
        "no_element",
        `There is no visible element [${ref}] on this page any more. Take a fresh snapshot and use a number from it.`,
      );
    }
  }

  async function pressKey({ cdp, session }: Page, key: string): Promise<void> {
    const spec = KEYS[key];
    if (!spec) {
      throw new SandboxError(
        "bad_request",
        `Unknown key "${key}". Use one of: ${BROWSER_KEYS.join(", ")}.`,
      );
    }
    const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode };
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: spec.text ? "keyDown" : "rawKeyDown",
        ...base,
        ...(spec.text ? { text: spec.text } : {}),
      },
      session,
    );
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, session);
  }

  return {
    open: (url) =>
      withPage(async (page) => {
        const loaded = page.cdp.next("Page.loadEventFired", {
          sessionId: page.session,
          timeoutMs: LOAD_TIMEOUT,
        });
        const { errorText } = await page.cdp.send<{ errorText?: string }>(
          "Page.navigate",
          { url },
          page.session,
        );
        if (errorText) {
          throw new SandboxError(
            "navigation_failed",
            errorText.includes("TUNNEL") || errorText.includes("PROXY")
              ? `Couldn't open ${url}: your computer is not allowed to reach that site (${errorText}). Trying again, or another address on the same site, will not work; tell the person, who can add the site to the allowed list.`
              : `Couldn't open ${url} (${errorText}).`,
          );
        }
        await loaded;
        await new Promise((r) => setTimeout(r, 300));
        const snapshot = await snapshotOf(page);
        // Plain-http pages the egress proxy refuses come back as its own page.
        if (snapshot.outline.startsWith("Blocked by the sandbox:")) {
          throw new SandboxError(
            "navigation_failed",
            `Couldn't open ${url}: ${snapshot.outline.replace("Blocked by the sandbox: ", "")}`,
          );
        }
        return snapshot;
      }),

    snapshot: () => withPage(snapshotOf),

    click: (ref) =>
      withPage(async (page) => {
        const { x, y } = await centre(page, ref);
        await act(page, async () => {
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
            await page.cdp.send(
              "Input.dispatchMouseEvent",
              { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 },
              page.session,
            );
          }
        });
        return snapshotOf(page);
      }),

    type: (ref, text, options = {}) =>
      withPage(async (page) => {
        try {
          await page.cdp.send("DOM.focus", { backendNodeId: ref }, page.session);
        } catch {
          throw new SandboxError(
            "no_element",
            `Element [${ref}] can't take text. Take a fresh snapshot and pick a textbox from it.`,
          );
        }
        if (options.clear) {
          const { object } = await page.cdp.send<{ object: { objectId?: string } }>(
            "DOM.resolveNode",
            { backendNodeId: ref },
            page.session,
          );
          if (object.objectId) {
            await page.cdp.send(
              "Runtime.callFunctionOn",
              {
                objectId: object.objectId,
                functionDeclaration:
                  "function () { if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); } else if (this.isContentEditable) { this.textContent = ''; } }",
              },
              page.session,
            );
          }
        }
        await page.cdp.send("Input.insertText", { text }, page.session);
        if (options.submit) await act(page, () => pressKey(page, "Enter"));
        return snapshotOf(page);
      }),

    press: (key) =>
      withPage(async (page) => {
        await act(page, () => pressKey(page, key));
        return snapshotOf(page);
      }),

    describe: (ref) =>
      withPage(async ({ cdp, session }) => {
        const history = await cdp.send<{
          currentIndex: number;
          entries: { url: string; title: string }[];
        }>("Page.getNavigationHistory", {}, session);
        const current = history.entries[history.currentIndex];
        let element: { role: string; name: string } | undefined;
        if (ref !== undefined) {
          try {
            const { nodes } = await cdp.send<{ nodes: AXNode[] }>(
              "Accessibility.getPartialAXTree",
              { backendNodeId: ref, fetchRelatives: false },
              session,
            );
            const node = nodes[0];
            if (node) {
              element = {
                role: String(node.role?.value ?? ""),
                name: String(node.name?.value ?? "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 200),
              };
            }
          } catch {
            // A stale number: the call itself will say so.
          }
        }
        return {
          url: current?.url ?? "",
          title: current?.title ?? "",
          ...(element ? { element } : {}),
        };
      }),

    back: () =>
      withPage(async (page) => {
        const history = await page.cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
          "Page.getNavigationHistory",
          {},
          page.session,
        );
        const previous = history.entries[history.currentIndex - 1];
        if (!previous)
          throw new SandboxError("bad_request", "There is no earlier page to go back to.");
        const loaded = page.cdp.next("Page.loadEventFired", {
          sessionId: page.session,
          timeoutMs: LOAD_TIMEOUT,
        });
        await page.cdp.send("Page.navigateToHistoryEntry", { entryId: previous.id }, page.session);
        await loaded;
        return snapshotOf(page);
      }),
  };
}

/** Cookies that belong to a site and its subdomains. */
function forDomain(domain: string) {
  const site = domain.toLowerCase().replace(/^\.+/, "");
  return (cookie: { domain: string }) => {
    const host = cookie.domain.toLowerCase().replace(/^\./, "");
    return host === site || host.endsWith(`.${site}`);
  };
}

/** Copy one site's cookies between two agents' browsers (ADR-0010 opt-in). */
export async function copyCookies(from: string, to: string, domain: string): Promise<number> {
  const source = await connectCdp(from);
  let cookies: { domain: string }[];
  try {
    const result = await source.send<{ cookies: { domain: string }[] }>("Storage.getCookies");
    cookies = result.cookies.filter(forDomain(domain));
  } finally {
    source.close();
  }
  if (cookies.length === 0) return 0;
  const target = await connectCdp(to);
  try {
    await target.send("Storage.setCookies", { cookies });
  } finally {
    target.close();
  }
  return cookies.length;
}
