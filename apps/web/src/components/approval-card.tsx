import { useDecideApproval } from "@ofa/client";
import type { Agent, Approval } from "@ofa/contracts";
import { Check, CheckCheck, Info, ShieldAlert, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { approvalFields, approveLabel, changedText, expiresIn } from "@/lib/approvals";
import { shortTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// A tool call waiting for a person (§6.2): what the agent wants to do, in
// plain words, why it asks, and Approve or Deny. The run waits, holding no
// process, until someone answers or the request expires. A call that carries
// written text (an email, a page, a comment) is a draft card: its arguments
// are listed and the text can be changed before approving (ADR-0030).

/** Why it asks, in plain words, from the policy's reasons. */
function why(approval: Approval): string {
  const reasons = approval.reasons.join(" ");
  const always = approval.reasons.find((r) => /always needs? a person/.test(r));
  if (always)
    return `${always.charAt(0).toUpperCase()}${always.slice(1)}, whatever its settings say.`;
  const rule = approval.reasons.find((r) => r.startsWith("asks first by"));
  if (rule) return `It asks first because of ${rule.replace(/^asks first by /, "")}.`;
  if (/opens an address/.test(reasons)) {
    return "It read outside content in this task, and this address didn't come from you or from anything it read, so it asks before opening it.";
  }
  if (/untrusted content/.test(reasons)) {
    return "It read outside content in this task, so it asks before acting on a site or its computer.";
  }
  if (/destructive/.test(reasons)) return "This may not be undoable, so it always asks first.";
  if (/tools that change things ask first/.test(reasons)) {
    return "You allowed this whole app: reading runs by itself, anything that changes something asks first.";
  }
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
  const fields = useMemo(() => approvalFields(approval), [approval]);
  const [values, setValues] = useState<Record<string, string>>({});
  const edits = changedText(fields, values);
  const edited = Object.keys(edits).length > 0;
  const formId = useId();
  const answer = (decision: "approve" | "reject", scope: "once" | "site" = "once") =>
    decide.mutate(
      { id: approval.id, decision, scope, ...(decision === "approve" && edited ? { edits } : {}) },
      { onError: (error) => toast({ message: error.message, tone: "error" }) },
    );
  const [first, ...rest] = approval.summary.split("\n");
  const busy = decide.isPending;
  const shown = fields.filter((f) => !f.editable);
  const editable = fields.filter((f) => f.editable);

  return (
    <section
      aria-label={`${agent.name} asks to: ${first}`}
      className={cn(
        "flex flex-col overflow-hidden rounded-[18px] border border-primary/40 bg-primary/[0.06]",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-primary/25 bg-primary/[0.08] px-4 py-3">
        <ShieldAlert className="size-[18px] shrink-0 text-primary" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="eyebrow text-[11px] text-primary">Needs you</span>
          <p className="text-[15px] leading-snug font-semibold break-words">
            {agent.name} wants to {first?.charAt(0).toLowerCase()}
            {first?.slice(1)}
          </p>
        </div>
        <span
          className="shrink-0 font-mono text-[11px] text-muted-foreground"
          title={`It waits until ${until(approval.expiresAt)}`}
        >
          {expiresIn(approval.expiresAt)}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        {rest.length > 0 && (
          <pre className="max-h-40 overflow-auto rounded-[10px] bg-background/70 px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap">
            {rest.join("\n")}
          </pre>
        )}
        {shown.length > 0 && (
          <dl className="grid grid-cols-[minmax(64px,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13.5px]">
            {shown.map((field) => (
              <div key={field.name} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="line-clamp-4 break-words whitespace-pre-wrap">
                  {field.value || <span className="text-muted-foreground">(empty)</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {editable.map((field) => {
          const value = values[field.name] ?? field.value;
          const id = `${formId}-${field.name}`;
          return (
            <div key={field.name} className="flex flex-col gap-1.5">
              <label htmlFor={id} className="text-[12px] text-muted-foreground">
                {field.label} · you can edit before approving
              </label>
              <textarea
                id={id}
                value={value}
                disabled={busy}
                rows={Math.min(
                  10,
                  Math.max(field.value.length > 80 ? 4 : 1, value.split("\n").length),
                )}
                onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                className="resize-y rounded-[12px] border border-input bg-background px-3 py-2.5 text-[13.5px] leading-normal outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              />
            </div>
          );
        })}
        <div className="flex gap-2.5 rounded-[12px] bg-warning/10 px-3 py-2.5 text-[12.5px] leading-snug">
          <Info className="mt-px size-4 shrink-0 text-warning" aria-hidden />
          <span>
            <b className="font-semibold">Why you’re asked:</b> {why(approval)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => answer("approve")}
            className="flex h-9 grow items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-[13.5px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:grow-0"
          >
            <Check className="size-4" aria-hidden />
            {approveLabel(approval.tool, edited)}
          </button>
          {approval.site && !edited && (
            // Only offered when outside content alone made it ask (M4.07).
            <button
              type="button"
              disabled={busy}
              onClick={() => answer("approve", "site")}
              title={`Clicking, typing and opening pages on ${approval.site} won't ask again in this task. Other sites still ask.`}
              className="flex h-9 items-center gap-1.5 rounded-full border border-primary/50 px-4 text-[13.5px] font-semibold text-primary outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <CheckCheck className="size-4" aria-hidden />
              Allow on {approval.site} for this task
            </button>
          )}
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
      </div>
    </section>
  );
}
