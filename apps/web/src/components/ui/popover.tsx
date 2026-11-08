import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// A small menu that opens beside its trigger (ADR-0052): it closes on Escape
// or a click outside, and grows from the corner nearest the trigger.

/** Close a popover on Escape or a click outside the returned element. */
export function useDismiss<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  close: () => void,
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);
  return ref;
}

const PLACE = {
  /** Opens upward from a trigger at the bottom left (the account button). */
  "above-start": "bottom-full left-0 mb-2 origin-bottom-left",
  /** Opens downward from a trigger at the top right (a ⋯ button). */
  "below-end": "top-full right-0 mt-2 origin-top-right",
  /** Opens downward from a trigger at the top left. */
  "below-start": "top-full left-0 mt-2 origin-top-left",
} as const;

export function PopoverPanel({
  place,
  label,
  className,
  children,
}: {
  place: keyof typeof PLACE;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="menu"
      aria-label={label}
      className={cn(
        "menu-pop absolute z-50 flex w-64 flex-col gap-0.5 rounded-[18px] border bg-popover p-1.5 text-popover-foreground shadow-2xl",
        PLACE[place],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The class of one row in a popover menu. */
export const MENU_ITEM =
  "press flex h-10 w-full items-center gap-3 rounded-[12px] px-3 text-left text-sm text-popover-foreground outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
