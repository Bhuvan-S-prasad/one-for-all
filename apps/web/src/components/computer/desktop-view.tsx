import RFB from "@novnc/novnc";
import type { Agent } from "@ofa/contracts";
import { Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// An agent's whole desktop on screen (ADR-0040): its browser, terminal, files
// and documents, streamed over VNC from /api/agents/:id/desktop and drawn by
// noVNC, scaled to fit. Watching is view-only; in control mode the person's
// mouse, keyboard and pastes reach the desktop. Nothing is recorded.

type State =
  | { readonly kind: "connecting" }
  | { readonly kind: "live" }
  | { readonly kind: "closed"; readonly message: string; readonly canRetry: boolean };

/** Same origin as the page; Vite proxies it in development. */
function desktopUrl(agentId: string, control: boolean): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/agents/${encodeURIComponent(agentId)}/desktop${control ? "?control=1" : ""}`;
}

/** Waits before reconnecting after a dropped view: 1 s, 2 s, 4 s, 8 s, then stop. */
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000];

export function DesktopView({
  agent,
  control,
  onControlRefused,
  onUnavailable,
  className,
}: {
  agent: Agent;
  control: boolean;
  /** Someone else has control: the parent goes back to watching. */
  onControlRefused?: () => void;
  /** The desktop can't be shown; the parent can offer the browser-only view. */
  onUnavailable?: () => void;
  className?: string;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [state, setState] = useState<State>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const callbacks = useRef({ onControlRefused, onUnavailable });
  useEffect(() => {
    callbacks.current = { onControlRefused, onUnavailable };
  });

  useEffect(() => {
    const target = screen.current;
    if (!target) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;

    const connect = () => {
      setState({ kind: "connecting" });
      // Our own socket, so the close code and reason are ours to read.
      const socket = new WebSocket(desktopUrl(agent.id, control));
      const client = new RFB(target, socket, { shared: true });
      client.viewOnly = !control;
      client.scaleViewport = true;
      client.clipViewport = false;
      client.resizeSession = false;
      client.focusOnClick = control;
      client.showDotCursor = false;
      client.background = "transparent";
      client.qualityLevel = 6;
      client.compressionLevel = 2;
      rfb.current = client;

      client.addEventListener("connect", () => {
        tries = 0;
        setState({ kind: "live" });
        if (control) client.focus({ preventScroll: true });
      });
      socket.addEventListener("close", (event) => {
        if (disposed) return;
        rfb.current = null;
        if (event.code === 4001) {
          setState({ kind: "closed", message: event.reason, canRetry: false });
          callbacks.current.onControlRefused?.();
          return;
        }
        if (event.code === 4002) {
          // Control moved to this person's newer window.
          setState({ kind: "closed", message: event.reason, canRetry: true });
          return;
        }
        if (event.code === 4004 || event.code === 4500) {
          setState({
            kind: "closed",
            message: event.reason || "The desktop couldn't start.",
            canRetry: true,
          });
          callbacks.current.onUnavailable?.();
          return;
        }
        // Dropped (a restart, the network): try again a few times.
        const delay = RETRY_DELAYS[tries];
        if (delay !== undefined) {
          tries += 1;
          setState({ kind: "connecting" });
          retry = setTimeout(connect, delay);
        } else {
          setState({ kind: "closed", message: "The view closed.", canRetry: true });
        }
      });
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [agent.id, control, attempt]);

  return (
    <div
      className={cn(
        "relative flex min-h-0 overflow-hidden rounded-[12px] border bg-black",
        control && "focus-within:ring-2 focus-within:ring-primary",
        className,
      )}
      onPaste={(e) => {
        // A paste goes to the desktop's clipboard; Ctrl+V there inserts it.
        const text = e.clipboardData.getData("text");
        if (control && text && rfb.current) {
          e.preventDefault();
          rfb.current.clipboardPasteFrom(text.slice(0, 10_000));
        }
      }}
    >
      <div
        ref={screen}
        role={control ? "application" : "img"}
        aria-label={
          control ? `${agent.name}'s computer: you have control` : `${agent.name}'s computer, live`
        }
        className="size-full"
      />
      {state.kind !== "live" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-[#8a8a90]">
          <Monitor className="size-6" aria-hidden />
          <span role="status">
            {state.kind === "connecting" ? "Starting the computer…" : state.message}
          </span>
          {state.kind === "closed" && state.canRetry && (
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="mt-1 rounded-full border border-[#3a3a40] px-3 py-1 text-[12.5px] text-[#d0d0d4] outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
