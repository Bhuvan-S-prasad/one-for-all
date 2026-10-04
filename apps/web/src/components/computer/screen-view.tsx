import { connectScreen, type ScreenConnection } from "@ofa/client";
import type { Agent, ScreenInputMessage } from "@ofa/contracts";
import { ArrowLeft, ArrowRight, Monitor, RotateCw } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { cn } from "@/lib/utils";

// An agent's browser on screen (M3.07, M3.10): frames streamed from the
// sandbox. In control mode the person's mouse, keyboard and pastes go to the
// page; the agent's browser tools wait until they hand it back. Nothing seen
// or typed here is recorded.

interface Frame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
}

/** Same origin as the page; Vite proxies it in development. */
function screenUrl(agentId: string, control: boolean): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/agents/${encodeURIComponent(agentId)}/screen${control ? "?control=1" : ""}`;
}

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

export function ScreenView({
  agent,
  control,
  onStatus,
  className,
}: {
  agent: Agent;
  control: boolean;
  /** Whether someone else has control, for the watcher's label. */
  onStatus?: (status: { takenOverByOther: boolean }) => void;
  className?: string;
}) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const connection = useRef<ScreenConnection | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);
  const statusRef = useRef(onStatus);
  useEffect(() => {
    statusRef.current = onStatus;
  });

  useEffect(() => {
    const conn = connectScreen({
      url: screenUrl(agent.id, control),
      onMessage: (message) => {
        if (message.type === "frame") {
          setFrame(message);
          setNotice(null);
        } else if (message.type === "status") {
          statusRef.current?.({ takenOverByOther: message.takenOverByOther });
          if (control && !message.control) {
            setNotice("Someone else has this browser right now. You can watch.");
          }
        } else if (message.type === "error") {
          setNotice(message.message);
        } else {
          setNotice(message.reason);
        }
      },
      onClose: () => setNotice((current) => current ?? "The view closed."),
    });
    connection.current = conn;
    return () => {
      connection.current = null;
      conn.close();
    };
  }, [agent.id, control]);

  // Follow the page's address unless the person is typing a new one.
  const shownAddress = editing ? address : (frame?.url ?? "");

  const send = (input: ScreenInputMessage) => {
    if (control) connection.current?.send(input);
  };

  /** A pointer position as CSS pixels of the page. */
  const point = (e: { clientX: number; clientY: number }) => {
    const rect = image.current?.getBoundingClientRect();
    if (!rect || !frame || rect.width === 0) return null;
    return {
      x: Math.max(0, Math.min(frame.width, ((e.clientX - rect.left) * frame.width) / rect.width)),
      y: Math.max(0, Math.min(frame.height, ((e.clientY - rect.top) * frame.height) / rect.height)),
    };
  };

  const onPointer = (action: "down" | "up" | "move", e: PointerEvent) => {
    if (!control) return;
    if (action === "move") {
      const now = performance.now();
      if (now - lastMove.current < 33) return; // ~30 moves a second is plenty.
      lastMove.current = now;
    }
    const p = point(e);
    if (!p) return;
    if (action === "down") (e.currentTarget as HTMLElement).focus();
    send({
      type: "mouse",
      action,
      ...p,
      button: BUTTONS[e.button] ?? "left",
      clicks: action === "move" ? undefined : Math.max(1, Math.min(3, e.detail || 1)),
      modifiers: modifiers(e),
    });
  };

  const onWheel = (e: WheelEvent) => {
    if (!control) return;
    const p = point(e);
    if (p) send({ type: "mouse", action: "wheel", ...p, deltaX: e.deltaX, deltaY: e.deltaY });
  };

  const onKey = (action: "down" | "up", e: KeyboardEvent) => {
    if (!control) return;
    // Let the browser keep paste, so it arrives as one insert below.
    if (action === "down" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    send({
      type: "key",
      action,
      key: e.key.slice(0, 32),
      code: e.code.slice(0, 32),
      ...(e.key.length === 1 && !e.ctrlKey && !e.metaKey ? { text: e.key } : {}),
      modifiers: modifiers(e),
    });
  };

  const go = (e: FormEvent) => {
    e.preventDefault();
    const raw = address.trim();
    if (!raw) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    send({ type: "navigate", url });
    setEditing(false);
  };

  const navButton =
    "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      <form onSubmit={go} className="flex items-center gap-1">
        <button
          type="button"
          className={navButton}
          disabled={!control}
          onClick={() => send({ type: "back" })}
          aria-label="Back"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          className={navButton}
          disabled={!control}
          onClick={() => send({ type: "reload" })}
          aria-label="Reload"
        >
          <RotateCw className="size-4" aria-hidden />
        </button>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Address</span>
          <input
            value={shownAddress}
            readOnly={!control}
            onFocus={() => {
              if (!control) return;
              setAddress(frame?.url ?? "");
              setEditing(true);
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            className="h-8 w-full truncate rounded-full border border-input bg-background px-3 font-mono text-[12px] text-muted-foreground outline-none focus:border-ring/60 focus:text-foreground"
          />
        </label>
        {control && (
          <button type="submit" className={navButton} aria-label="Go">
            <ArrowRight className="size-4" aria-hidden />
          </button>
        )}
      </form>

      <div
        tabIndex={control ? 0 : -1}
        role={control ? "application" : undefined}
        aria-label={
          control ? `${agent.name}'s browser: you have control` : `${agent.name}'s browser`
        }
        onPointerDown={(e) => onPointer("down", e)}
        onPointerUp={(e) => onPointer("up", e)}
        onPointerMove={(e) => onPointer("move", e)}
        onWheel={onWheel}
        onKeyDown={(e) => onKey("down", e)}
        onKeyUp={(e) => onKey("up", e)}
        onContextMenu={(e) => control && e.preventDefault()}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (control && text) {
            e.preventDefault();
            send({ type: "text", text: text.slice(0, 10_000) });
          }
        }}
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[12px] border bg-black outline-none",
          control && "cursor-default focus-visible:ring-2 focus-visible:ring-primary",
        )}
      >
        {frame ? (
          <img
            ref={image}
            src={`data:image/jpeg;base64,${frame.data}`}
            alt={`${agent.name}'s browser`}
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-[#8a8a90]">
            <Monitor className="size-6" aria-hidden />
            {notice ?? "Starting the browser…"}
          </div>
        )}
        {frame && notice && (
          <div className="absolute inset-x-3 bottom-3 rounded-[10px] bg-black/75 px-3 py-2 text-center text-[12.5px] text-white">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
