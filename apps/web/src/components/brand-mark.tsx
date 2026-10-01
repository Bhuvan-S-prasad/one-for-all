import { cn } from "@/lib/utils";

/** The One-for-All mark: one agent at the centre of its team. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
      className={cn("size-6 text-primary", className)}
    >
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
      <circle cx="12" cy="12" r="9" strokeDasharray="2.6 3.2" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="font-display text-xl font-semibold tracking-tight">One-for-All</span>
    </span>
  );
}
