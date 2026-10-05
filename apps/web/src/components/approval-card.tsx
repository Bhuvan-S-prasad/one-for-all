import { useDecideApproval } from "@ofa/client";
import type { Agent, Approval } from "@ofa/contracts";
import { Check, ShieldAlert, X } from "lucide-react";
import { shortTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// A tool call waiting for a person (§6.2): what the agent wants to do, in
// plain words, why it asks, and Approve or Deny. The run waits, holding no
// process, until someone answers or the request expires.

/** Why it asks, in plain words, from the policy's reasons. */
function why(approval: Approval): string {
  const reasons = approval.reasons.join(" ");
  if (/opens an address/.test(reasons)) {
    return "It read outside content in this task, and this address didn't come from you or from anything it read, so it asks before opening it.";
  }
  if (/untrusted content/.test(reasons)) {
    return "It read outside content in this task, so it asks before acting on a site or its computer.";
  }
  if (/destructive/.test(reasons)) return "This can't be undone, so it always asks first.";
  if (/granted as approve/.test(reasons)) return "You asked to approve this tool each time.";
  return "Policy asks for a person here.";
}

/** Requests wait up to a day: "14:05" today, or "tomorrow at 14:05". */
function until(iso: string): string {
  const same = new Date(iso).toDateString() === new Date().toDateString();
  return same ? shortTime(iso) : `tomorrow at ${shortTime(iso)}`;
}

export function ApprovalCard({
  approval,
  agent,
  className,
}: {
  approval: Approval;
  agent: Pick<Agent, "name">;
  className?: string;
}) {
  const decide = useDecideApproval();
  const answer = (decision: "approve" | "reject") =>
    decide.mutate(
      { id: approval.id, decision },
      { onError: (error) => toast({ message: error.message, tone: "error" }) },
    );
  const [first, ...rest] = approval.summary.split("\n");
  const busy = decide.isPending;

  return (
    <section
      aria-label={`${agent.name} asks to: ${first}`}
      className={cn(
        "flex flex-col gap-3 rounded-[18px] border border-primary/40 bg-primary/[0.06] px-4 py-3.5",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="eyebrow text-primary">Needs you</span>
          <p className="text-[15px] leading-snug font-semibold break-words">
            {agent.name} wants to {first?.charAt(0).toLowerCase()}
            {first?.slice(1)}
          </p>
          {rest.length > 0 && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-[10px] bg-background/70 px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap">
              {rest.join("\n")}
            </pre>
          )}
          <p className="text-[13px] text-muted-foreground">
            {why(approval)} It waits until {until(approval.expiresAt)}.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-7">
        <button
          type="button"
          disabled={busy}
          onClick={() => answer("approve")}
          className="flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13.5px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <Check className="size-4" aria-hidden />
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => answer("reject")}
          className="flex h-9 items-center gap-1.5 rounded-full border border-input px-4 text-[13.5px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <X className="size-4" aria-hidden />
          Deny
        </button>
      </div>
    </section>
  );
}
