import { cn } from "@/lib/utils";

/** The One-for-All mark: a four-point spark. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-6.5 text-primary", className)}>
      <path
        d="M12 1.5Q12 12 22.5 12Q12 12 12 22.5Q12 12 1.5 12Q12 12 12 1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="font-display text-[21px] font-extrabold tracking-[-0.03em]">
        One-for-All
      </span>
    </span>
  );
}
