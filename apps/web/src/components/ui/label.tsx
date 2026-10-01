import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Form label in the mono caps style. */
export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("eyebrow text-muted-foreground", className)} {...props} />;
}
