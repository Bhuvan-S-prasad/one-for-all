import { Link } from "@tanstack/react-router";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { MENU_ITEM, PopoverPanel, useDismiss } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// A chat's ⋯ menu (ADR-0052): the actions that used to crowd its header.

export type ChatMenuItem =
  | {
      readonly kind: "link";
      readonly label: string;
      readonly icon: LucideIcon;
      readonly to: string;
      readonly params?: Record<string, string>;
      readonly search?: Record<string, string>;
      readonly hint?: string;
    }
  | {
      readonly kind: "action";
      readonly label: string;
      readonly icon: LucideIcon;
      readonly onSelect: () => void;
      readonly disabled?: boolean;
      readonly hint?: string;
      /** Only on wide screens, e.g. the steps panel. */
      readonly wideOnly?: boolean;
    }
  | { readonly kind: "divider" };

export function ChatMenu({ label, items }: { label: string; items: readonly ChatMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        title="More"
        onClick={() => setOpen(!open)}
        className={cn(
          "press flex size-10 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          open ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <MoreHorizontal className="size-[19px]" aria-hidden />
      </button>
      {open && (
        <PopoverPanel place="below-end" label={label}>
          {items.map((item, i) => {
            if (item.kind === "divider") return <div key={`d${i}`} className="my-1 border-t" />;
            const Icon = item.icon;
            const content = (
              <>
                <Icon className="size-4 text-muted-foreground" aria-hidden />
                <span className="flex-1 truncate">{item.label}</span>
                {item.hint && (
                  <kbd className="font-mono text-[11px] text-muted-foreground">{item.hint}</kbd>
                )}
              </>
            );
            if (item.kind === "link") {
              return (
                <Link
                  key={item.label}
                  to={item.to}
                  params={item.params as never}
                  search={item.search as never}
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={close}
                >
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cn(MENU_ITEM, item.wideOnly && "hidden lg:flex")}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {content}
              </button>
            );
          })}
        </PopoverPanel>
      )}
    </div>
  );
}
