import { useEffect, useRef, useSyncExternalStore } from "react";

// Keyboard shortcuts (UX.04). Page jumps are two-key sequences ("g" then "a"),
// because browsers keep Ctrl+1–9 for switching tabs. Single keys never fire
// while someone is typing; ⌘K / Ctrl+K and Escape always do.

export const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** "⌘K" on a Mac, "Ctrl K" elsewhere. */
export const MOD_K = IS_MAC ? "⌘K" : "Ctrl K";

export interface Shortcut {
  /** Shown in tooltips and the shortcut list, e.g. "G A". */
  readonly keys: string;
  readonly label: string;
}

/** Page jumps, by the second key after "g". */
export const GO_KEYS = { h: "/", a: "/agents", r: "/activity", s: "/settings" } as const;

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: MOD_K, label: "Search and commands" },
  { keys: "[", label: "Hide or show the sidebar" },
  { keys: "G H", label: "Go to your latest chat" },
  { keys: "G A", label: "Go to Agents" },
  { keys: "G R", label: "Go to Activity" },
  { keys: "G S", label: "Go to Settings" },
  { keys: "/", label: "Write a message (in a chat)" },
  { keys: "N", label: "New chat (in a chat)" },
  { keys: "Esc", label: "Stop the agent (in a chat, while it works)" },
  { keys: "Enter · Shift Enter", label: "Send · new line" },
];

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    // A taken-over browser (M3.10) takes every key.
    target.closest('[role="application"]') !== null
  );
}

export interface GlobalShortcutHandlers {
  readonly openPalette: () => void;
  readonly toggleSidebar: () => void;
  readonly go: (to: (typeof GO_KEYS)[keyof typeof GO_KEYS]) => void;
}

/** App-wide shortcuts, mounted once in the shell. */
export function useGlobalShortcuts(handlers: GlobalShortcutHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    let pendingG = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        ref.current.openPalette();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (pendingG && Date.now() - pendingG < 1_200 && key in GO_KEYS) {
        event.preventDefault();
        pendingG = 0;
        ref.current.go(GO_KEYS[key as keyof typeof GO_KEYS]);
        return;
      }
      pendingG = key === "g" ? Date.now() : 0;
      if (event.key === "[") {
        event.preventDefault();
        ref.current.toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// ── Remembered layout choices (per device) ──────────────────────────────────

const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Storage blocked: fall back to the default.
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not saved; still applies for this page.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A boolean layout choice kept in this browser, e.g. a folded sidebar. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => {
    const stored = read(key);
    return stored === null ? fallback : stored === "1";
  });
  return [value, (next: boolean) => write(key, next ? "1" : "0")];
}
