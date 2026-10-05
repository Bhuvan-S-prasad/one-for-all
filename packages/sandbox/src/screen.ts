import { SandboxError, type ScreenFrame, type ScreenInput, type ScreenSession } from "@ofa/core";
import { connectCdp } from "./cdp";

// A person's view of an agent's browser (M3.07, ADR-0025): the page streamed
// as JPEG frames (CDP screencast), and the person's mouse and keyboard sent
// back as input events. No VNC: the browser is the only thing on the screen.
// Frames go to the viewer only; nothing is stored.

const SCREENCAST = {
  format: "jpeg",
  quality: 60,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
};

/** Keys whose CDP events need a Windows key code to do anything. */
const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};

/** Keys that type a character as well: Enter submits a form only with its "\r". */
const KEY_TEXT: Record<string, string> = { Enter: "\r" };

const MOUSE_TYPES = {
  move: "mouseMoved",
  down: "mousePressed",
  up: "mouseReleased",
  wheel: "mouseWheel",
} as const;

export async function createScreenSession(endpoint: string): Promise<ScreenSession> {
  const cdp = await connectCdp(endpoint);
  const frameListeners = new Set<(frame: ScreenFrame) => void>();
  const endListeners = new Set<(reason: string) => void>();
  let ended = false;
  let url = "";

  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    for (const listener of endListeners) listener(reason);
    cdp.close();
  };

  try {
    const { targetInfos } = await cdp.send<{
      targetInfos: { targetId: string; type: string; url: string }[];
    }>("Target.getTargets");
    const page = targetInfos
      .filter((t) => t.type === "page" && !t.url.startsWith("devtools:"))
      .at(-1);
    const targetId =
      page?.targetId ??
      (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }))
        .targetId;
    url = page?.url ?? "about:blank";
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    cdp.on("Page.screencastFrame", (params, from) => {
      if (from !== sessionId) return;
      const metadata = params.metadata as { deviceWidth: number; deviceHeight: number };
      // Acknowledge, or Chromium stops sending.
      void cdp
        .send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId)
        .catch(() => {});
      const frame: ScreenFrame = {
        data: String(params.data),
        width: Math.round(metadata.deviceWidth),
        height: Math.round(metadata.deviceHeight),
        url,
      };
      for (const listener of frameListeners) listener(frame);
    });
    cdp.on("Page.frameNavigated", (params, from) => {
      const frame = params.frame as { parentId?: string; url: string };
      if (from === sessionId && !frame.parentId) url = frame.url;
    });
    cdp.onClose(() => end("The browser closed."));
    cdp.on("Target.detachedFromTarget", (params) => {
      if (params.sessionId === sessionId) end("The page was closed.");
    });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.startScreencast", SCREENCAST, sessionId);

    return {
      onFrame: (listener) => void frameListeners.add(listener),
      onEnd: (listener) => void endListeners.add(listener),
      async input(event: ScreenInput) {
        if (ended) return;
        switch (event.type) {
          case "mouse":
            await cdp.send(
              "Input.dispatchMouseEvent",
              {
                type: MOUSE_TYPES[event.action],
                x: event.x,
                y: event.y,
                button:
                  event.action === "move" || event.action === "wheel"
                    ? "none"
                    : (event.button ?? "left"),
                clickCount:
                  event.action === "down" || event.action === "up" ? (event.clicks ?? 1) : 0,
                deltaX: event.deltaX ?? 0,
                deltaY: event.deltaY ?? 0,
                modifiers: event.modifiers ?? 0,
              },
              sessionId,
            );
            return;
          case "key": {
            const text =
              event.action === "down"
                ? (KEY_TEXT[event.key] ?? (event.text?.length === 1 ? event.text : undefined))
                : undefined;
            const printable = text !== undefined;
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: event.action === "up" ? "keyUp" : printable ? "keyDown" : "rawKeyDown",
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode:
                  KEY_CODES[event.key] ??
                  (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0),
                modifiers: event.modifiers ?? 0,
                ...(printable ? { text, unmodifiedText: text } : {}),
              },
              sessionId,
            );
            return;
          }
          case "text":
            await cdp.send("Input.insertText", { text: event.text.slice(0, 10_000) }, sessionId);
            return;
          case "navigate": {
            const { errorText } = await cdp.send<{ errorText?: string }>(
              "Page.navigate",
              { url: event.url },
              sessionId,
            );
            if (errorText)
              throw new SandboxError(
                "navigation_failed",
                `Couldn't open ${event.url} (${errorText}).`,
              );
            return;
          }
          case "back": {
            const history = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
              "Page.getNavigationHistory",
              {},
              sessionId,
            );
            const previous = history.entries[history.currentIndex - 1];
            if (previous)
              await cdp.send("Page.navigateToHistoryEntry", { entryId: previous.id }, sessionId);
            return;
          }
          case "reload":
            await cdp.send("Page.reload", {}, sessionId);
            return;
        }
      },
      close() {
        if (ended) return;
        ended = true;
        void cdp
          .send("Page.stopScreencast", {}, sessionId)
          .catch(() => {})
          .finally(() => cdp.close());
      },
    };
  } catch (error) {
    cdp.close();
    throw error;
  }
}
