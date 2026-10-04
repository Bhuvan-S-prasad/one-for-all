import { X } from "lucide-react";
import { dismissToast, holdToast, runToastAction, useToasts } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Where toasts appear (UX.15): bottom left on wide screens, above the tab bar
 * on phones. Announced politely; hovering or focusing one keeps it up.
 */
export function Toaster({ raised }: { raised: boolean }) {
  const toasts = useToasts();
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className={cn(
        "pointer-events-none fixed inset-x-3 z-50 flex flex-col items-center gap-2 md:right-auto md:bottom-5 md:left-5 md:items-start",
        raised ? "bottom-24" : "bottom-4",
      )}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          onMouseEnter={() => holdToast(t.id, true)}
          onMouseLeave={() => holdToast(t.id, false)}
          onFocus={() => holdToast(t.id, true)}
          onBlur={() => holdToast(t.id, false)}
          className={cn(
            "toast-in pointer-events-auto flex max-w-[min(440px,100%)] items-center gap-1 rounded-full py-1.5 pr-1.5 pl-4.5 text-[14px] shadow-2xl",
            t.tone === "error"
              ? "border border-destructive/40 bg-destructive-surface text-destructive"
              : "bg-foreground text-background",
          )}
        >
          <span className="min-w-0 flex-1 truncate py-1.5 pr-2">{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => runToastAction(t.id)}
              className="h-8 shrink-0 rounded-full bg-primary px-3.5 text-[13.5px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
            className="flex size-8 shrink-0 items-center justify-center rounded-full opacity-70 outline-none hover:bg-background/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
