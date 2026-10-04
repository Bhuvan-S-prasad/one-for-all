import { useSyncExternalStore } from "react";

// Small confirmations with an optional Undo (UX.15): "Researcher paused · Undo".
// One store for the app, shown by <Toaster /> in the shell, so a toast
// survives moving to another page.

export type ToastEnd = "action" | "timeout" | "closed";

export interface ToastInput {
  readonly message: string;
  /** One action, usually Undo. */
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** Milliseconds on screen; 5 seconds by default. */
  readonly duration?: number;
  /**
   * Called once when the toast goes, with why. Deferred work (forgetting a
   * memory) commits here unless the person pressed Undo.
   */
  readonly onEnd?: (end: ToastEnd) => void;
  readonly tone?: "default" | "error";
}

export interface Toast extends ToastInput {
  readonly id: number;
}

const MAX_TOASTS = 3;
let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

/** Show a toast; returns its ID. */
export function toast(input: ToastInput | string): number {
  const value: ToastInput = typeof input === "string" ? { message: input } : input;
  const id = nextId++;
  // The oldest toasts give way; their deferred work still runs.
  const overflow = toasts.slice(0, Math.max(0, toasts.length + 1 - MAX_TOASTS));
  for (const old of overflow) dismissToast(old.id, "timeout");
  toasts = [...toasts, { ...value, id }];
  timers.set(
    id,
    setTimeout(() => dismissToast(id, "timeout"), value.duration ?? 5_000),
  );
  emit();
  return id;
}

export function dismissToast(id: number, end: ToastEnd = "closed"): void {
  const found = toasts.find((t) => t.id === id);
  if (!found) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
  found.onEnd?.(end);
}

/** Run the toast's action, then close it. */
export function runToastAction(id: number): void {
  const found = toasts.find((t) => t.id === id);
  if (!found?.action) return;
  found.action.onClick();
  dismissToast(id, "action");
}

/** Hover or focus keeps a toast up; leaving restarts a short timer. */
export function holdToast(id: number, hold: boolean): void {
  const found = toasts.find((t) => t.id === id);
  if (!found) return;
  clearTimeout(timers.get(id));
  if (hold) timers.delete(id);
  else
    timers.set(
      id,
      setTimeout(() => dismissToast(id, "timeout"), 2_500),
    );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
}
