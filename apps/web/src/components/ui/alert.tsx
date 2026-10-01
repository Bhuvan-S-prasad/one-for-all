import { CircleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Inline error message for forms. */
export function ErrorAlert({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-2.5 rounded-md bg-destructive-surface px-3.5 py-3 text-sm text-destructive",
        className,
      )}
      {...props}
    >
      <CircleAlert className="size-[18px] shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
