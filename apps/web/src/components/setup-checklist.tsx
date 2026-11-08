import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/card";
import { useStoredFlag } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

// First-run setup (UX.11): the checklist while something essential is
// missing; afterwards a chip, which can be closed for good on this device.

const PRIMARY_SMALL =
  "press flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring";

export function SetupChecklist({
  hasKey,
  hasAgent,
  loading,
  chip = true,
}: {
  hasKey: boolean;
  hasAgent: boolean;
  loading: boolean;
  /** Show the small "done" chip once setup is complete. */
  chip?: boolean;
}) {
  const [dismissed, setDismissed] = useStoredFlag("ofa-setup-chip-hidden", false);
  if (loading) return null;
  const steps = [
    { title: "Create the owner account and workspace", done: true },
    { title: "Add your model key", done: hasKey, to: "/settings" as const },
    { title: "Hatch your first agent", done: hasAgent, to: "/agents/new" as const },
    { title: "Connect a channel", done: false, soon: true },
  ];
  const done = steps.filter((s) => s.done).length;

  if (hasKey && hasAgent) {
    if (dismissed || !chip) return null;
    return (
      <div className="flex items-center gap-2 self-start rounded-full border bg-card py-1 pr-1 pl-3.5 text-[13px] text-muted-foreground">
        <span>
          Setup {done} of {steps.length} · Connect a channel arrives soon
        </span>
        <button
          type="button"
          aria-label="Hide setup"
          onClick={() => setDismissed(true)}
          className="flex size-7 items-center justify-center rounded-full outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline justify-between px-5 pt-4 pb-3">
        <CardTitle>Get started</CardTitle>
        <span className="font-mono text-xs text-muted-foreground">
          {done} of {steps.length}
        </span>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.title} className="flex items-center gap-4 border-t px-5 py-3">
            <span className="w-4 font-mono text-[13px] text-muted-foreground">{index + 1}</span>
            <span
              className={cn(
                "flex-1 text-[15px] font-semibold",
                step.done && "text-muted-foreground line-through",
              )}
            >
              {step.title}
            </span>
            {step.done ? (
              <span className="eyebrow rounded-full bg-success px-2.5 py-1 text-[11px] text-background">
                Done
              </span>
            ) : step.to ? (
              <Link to={step.to} className={PRIMARY_SMALL}>
                Do it
              </Link>
            ) : (
              <span className="eyebrow rounded-full border px-2.5 py-[3px] text-[11px] text-muted-foreground">
                Soon
              </span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
