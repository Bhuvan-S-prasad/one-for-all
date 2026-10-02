import { MOOD_LABELS } from "@ofa/client";
import type { FamiliarMood } from "@ofa/contracts";
import { cn } from "@/lib/utils";

const STYLE: Record<FamiliarMood, string> = {
  idle: "bg-accent text-muted-foreground",
  thinking: "bg-info/15 text-info",
  working: "bg-highlight/15 text-highlight",
  waiting: "bg-warning/15 text-warning",
  asleep: "bg-accent text-muted-foreground",
  error: "bg-destructive-surface text-destructive",
};

/** A mood as a dot and a word, never colour alone. */
export function MoodPill({
  mood,
  suffix,
  className,
}: {
  mood: FamiliarMood;
  suffix?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "eyebrow inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium",
        STYLE[mood],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {MOOD_LABELS[mood]}
      {suffix && <span className="opacity-80">· {suffix}</span>}
    </span>
  );
}
