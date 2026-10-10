import type { RunEvent } from "@ofa/contracts";
import { count, duration } from "./format";

// A run's log as a person reads it (UX.10): what happened, in order, with
// runs of page reads grouped and routine checks hidden. The raw log stays one
// toggle away in Activity.

export interface TimelineChild {
  readonly label: string;
  readonly detail: string | null;
  readonly state: "done" | "failed" | "active";
}

export interface TimelineItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly state: "done" | "failed" | "warn" | "active" | "info";
  readonly at: string;
  readonly children?: readonly TimelineChild[];
}

export interface Timeline {
  readonly items: TimelineItem[];
  /** Policy checks that allowed a call without asking, left out of `items`. */
  readonly hiddenChecks: number;
}

function host(url: unknown): string {
  if (typeof url !== "string") return "a page";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const TOOL_DONE: Record<string, string> = {
  "web.search": "Searched the web",
  remember: "Saved to memory",
  recall: "Checked its memory",
  "todo.write": "Made a plan",
  delegate_task: "Handed work to another agent",
  message_agent: "Messaged another agent",
  schedule_task: "Scheduled a task for later",
  remind_me: "Set a reminder",
  run_skill: "Opened a skill",
  save_skill: "Saved a skill",
};

/** How a run was started, as Activity says it. */
const TRIGGERS: Record<string, string> = {
  message: "from chat",
  routine: "on a routine's schedule",
  manual: "a routine's test run",
  schedule: "a task it set for now",
  delegation: "handed over by another agent",
  event: "woken by another agent",
};

export function timeline(events: readonly RunEvent[]): Timeline {
  const items: TimelineItem[] = [];
  let hiddenChecks = 0;
  const calls = new Map<string, { tool: string; args: unknown; at: string }>();
  const outcome = new Map<string, { ok: boolean; message?: string; durationMs: number }>();
  for (const e of events) {
    if (e.type === "tool.completed")
      outcome.set(e.payload.toolCallId, { ok: true, durationMs: e.payload.durationMs });
    if (e.type === "tool.failed")
      outcome.set(e.payload.toolCallId, {
        ok: false,
        message: e.payload.message,
        durationMs: e.payload.durationMs,
      });
  }

  let reads: { id: string; at: string; children: TimelineChild[] } | null = null;
  const closeReads = () => {
    if (!reads) return;
    const ok = reads.children.filter((c) => c.state === "done").length;
    const failed = reads.children.filter((c) => c.state === "failed").length;
    const going = reads.children.some((c) => c.state === "active");
    const pages = reads.children.length;
    items.push({
      id: reads.id,
      title: pages === 1 ? (going ? "Reading a page" : "Read a page") : `Read ${pages} pages`,
      detail:
        pages === 1
          ? (reads.children[0]?.detail ?? null)
          : [ok && failed ? `${ok} read` : null, failed ? `${failed} couldn't load` : null]
              .filter(Boolean)
              .join(" · ") || null,
      state: going ? "active" : failed === pages ? "failed" : "done",
      at: reads.at,
      ...(pages > 1 ? { children: reads.children } : {}),
    });
    reads = null;
  };

  let learning = false;
  for (const e of events) {
    switch (e.type) {
      case "run.started":
        items.push({
          id: e.id,
          title: "Started",
          detail: `${TRIGGERS[e.payload.trigger] ?? e.payload.trigger} · ${e.payload.tier} tier`,
          state: "info",
          at: e.createdAt,
        });
        break;
      case "policy.decided":
        if (e.payload.verdict === "auto") hiddenChecks += 1;
        else {
          closeReads();
          items.push({
            id: e.id,
            title:
              e.payload.verdict === "deny"
                ? `Not allowed to use ${e.payload.tool}`
                : `Asked you before using ${e.payload.tool}`,
            detail: e.payload.reasons[0] ?? null,
            state: "warn",
            at: e.createdAt,
          });
        }
        break;
      case "tool.called": {
        calls.set(e.payload.toolCallId, {
          tool: e.payload.tool,
          args: e.payload.args,
          at: e.createdAt,
        });
        const result = outcome.get(e.payload.toolCallId);
        const state = result ? (result.ok ? "done" : "failed") : "active";
        if (e.payload.tool === "web.read_url") {
          const args = e.payload.args as { url?: unknown; from?: unknown } | null;
          reads ??= { id: e.id, at: e.createdAt, children: [] };
          reads.children.push({
            label: host(args?.url),
            detail:
              state === "failed"
                ? (result?.message ?? "failed")
                : typeof args?.from === "number" && args.from > 0
                  ? "read further"
                  : result
                    ? duration(result.durationMs)
                    : null,
            state,
          });
          break;
        }
        closeReads();
        const args = (e.payload.args ?? {}) as Record<string, unknown>;
        const detail =
          e.payload.tool === "web.search" || e.payload.tool === "recall"
            ? typeof args.query === "string"
              ? `“${args.query}”`
              : null
            : e.payload.tool === "remember" && typeof args.fact === "string"
              ? args.fact
              : e.payload.tool === "todo.write" && Array.isArray(args.items)
                ? count(args.items.length, "item")
                : null;
        items.push({
          id: e.id,
          title:
            state === "failed"
              ? `Couldn't use ${e.payload.tool}`
              : state === "active"
                ? `Using ${e.payload.tool}`
                : (TOOL_DONE[e.payload.tool] ?? `Used ${e.payload.tool}`),
          detail: state === "failed" ? (result?.message ?? detail) : detail,
          state,
          at: e.createdAt,
        });
        break;
      }
      case "tool.failed":
        // Shown on its call; a failure without a call (an invalid one) shows here.
        if (!calls.has(e.payload.toolCallId)) {
          closeReads();
          items.push({
            id: e.id,
            title: `Asked for a tool it can't use`,
            detail: e.payload.message,
            state: "failed",
            at: e.createdAt,
          });
        }
        break;
      case "run.tainted":
        closeReads();
        items.push({
          id: e.id,
          title: "Read outside content",
          detail: "From here on, sending anything out needs approval.",
          state: "warn",
          at: e.createdAt,
        });
        break;
      case "approval.decided":
        closeReads();
        items.push({
          id: e.id,
          title:
            e.payload.decision === "approved"
              ? "You allowed it"
              : e.payload.decision === "edited"
                ? "You changed it, then allowed it"
                : e.payload.decision === "rejected"
                  ? "You said no"
                  : "No answer in time, so it was not done",
          detail: e.payload.edited?.length ? `Changed: ${e.payload.edited.join(", ")}` : null,
          state:
            e.payload.decision === "approved" || e.payload.decision === "edited" ? "done" : "info",
          at: e.createdAt,
        });
        break;
      case "run.waiting":
        // Waiting for a person shows as the request and its answer.
        if (e.payload.reason === "approval") break;
        closeReads();
        items.push({
          id: e.id,
          title: e.payload.reason === "model_capacity" ? "Waited for the model" : "Waited",
          detail:
            e.payload.reason === "model_capacity" ? "Free models allow 20 requests a minute" : null,
          state: "warn",
          at: e.createdAt,
        });
        break;
      case "model.failed":
        closeReads();
        items.push({
          id: e.id,
          title: "A model didn't answer",
          detail: `${e.payload.model}: ${e.payload.message}`,
          state: "warn",
          at: e.createdAt,
        });
        break;
      case "check.quiet":
        closeReads();
        items.push({
          id: e.id,
          title: "Nothing needed you, so it stayed quiet",
          detail: null,
          state: "done",
          at: e.createdAt,
        });
        break;
      case "run.steered":
        closeReads();
        items.push({
          id: e.id,
          title: "Read what you added",
          detail: e.payload.preview,
          state: "info",
          at: e.createdAt,
        });
        break;
      case "run.compacted":
        closeReads();
        items.push({
          id: e.id,
          title: "Summarised earlier steps to make room",
          detail: `${e.payload.tokensBefore.toLocaleString()} → ${e.payload.tokensAfter.toLocaleString()} tokens`,
          state: "done",
          at: e.createdAt,
        });
        break;
      case "message.created":
        closeReads();
        items.push({
          id: e.id,
          title: "Wrote the answer",
          detail: null,
          state: "done",
          at: e.createdAt,
        });
        break;
      case "run.ended":
        closeReads();
        if (e.payload.status !== "succeeded") {
          items.push({
            id: e.id,
            title: e.payload.status === "cancelled" ? "Stopped" : "Failed",
            detail: e.payload.error?.message ?? e.payload.stopReason.replaceAll("_", " "),
            state: e.payload.status === "cancelled" ? "info" : "failed",
            at: e.createdAt,
          });
        } else if (e.payload.stopReason !== "final_answer") {
          items.push({
            id: e.id,
            title: "Stopped early",
            detail: e.payload.stopReason.replaceAll("_", " "),
            state: "warn",
            at: e.createdAt,
          });
        }
        break;
      case "model.called":
        // The learning pass runs after the reply; one line for it and its memories.
        if (e.payload.promptVersion?.startsWith("memory.extract") && !learning) {
          learning = true;
          closeReads();
          const saved = events.filter((x) => x.type === "memory.written");
          const unverified = saved.filter(
            (x) => x.type === "memory.written" && !x.payload.verified,
          ).length;
          items.push({
            id: e.id,
            title: "Looked back for things to remember",
            detail: saved.length
              ? `${count(saved.length, "fact")} saved${unverified ? ` · ${unverified} unverified` : ""}`
              : "Nothing worth keeping",
            state: "done",
            at: e.createdAt,
          });
        }
        break;
      default:
        break;
    }
  }
  closeReads();
  return { items, hiddenChecks };
}
