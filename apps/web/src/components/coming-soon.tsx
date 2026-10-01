import { SquareDashed } from "lucide-react";
import { Card } from "@/components/ui/card";

/** Empty state for sections that arrive in later milestones. */
export function ComingSoon({ heading, children }: { heading: string; children: string }) {
  return (
    <Card className="flex flex-col items-center gap-3.5 px-8 py-16 text-center">
      <span className="flex size-13 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SquareDashed className="size-6" aria-hidden />
      </span>
      <span className="rounded bg-accent px-2 py-0.5 text-xs font-semibold tracking-wide text-accent-foreground uppercase">
        Coming soon
      </span>
      <h2 className="text-2xl font-semibold">{heading}</h2>
      <p className="max-w-md text-[15px] leading-relaxed text-muted-foreground">{children}</p>
    </Card>
  );
}
