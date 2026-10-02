import type { RunEvent } from "@ofa/contracts";

// Turn a run's event log into the steps a person cares about: what it looked
// up, read or saved, and whether each worked. The full log is in Activity.

const TOOL_LABELS: Record<string, [doing: string, done: string]> = {
  "web.search": ["Searching the web", "Searched the web"],
  "web.read_url": ["Reading a page", "Read a page"],
  remember: ["Saving to memory", "Saved to memory"],
  recall: ["Checking memory", "Checked memory"],
  "todo.write": ["Planning", "Updated the plan"],
};

export interface RunStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly state: "done" | "active" | "failed" | "blocked";
}

function detailFor(tool: string, args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "web.search" && typeof a.query === "string") return a.query;
  if (tool === "web.read_url" && typeof a.url === "string") {
    try {
      return new URL(a.url).hostname;
    } catch {
      return null;
    }
  }
  if (tool === "remember" && typeof a.fact === "string") return a.fact;
  if (tool === "recall" && typeof a.query === "string") return a.query;
  return null;
}

export function runSteps(events: readonly RunEvent[]): RunStep[] {
  const steps = new Map<string, RunStep>();
  for (const event of events) {
    switch (event.type) {
      case "tool.called": {
        const [doing] = TOOL_LABELS[event.payload.tool] ?? [`Using ${event.payload.tool}`];
        steps.set(event.payload.toolCallId, {
          id: event.payload.toolCallId,
          label: doing,
          detail: detailFor(event.payload.tool, event.payload.args),
          state: "active",
        });
        break;
      }
      case "tool.completed": {
        const step = steps.get(event.payload.toolCallId);
        const [, done] = TOOL_LABELS[event.payload.tool] ?? ["", `Used ${event.payload.tool}`];
        if (step) steps.set(step.id, { ...step, label: done, state: "done" });
        break;
      }
      case "tool.failed": {
        const step = steps.get(event.payload.toolCallId);
        steps.set(event.payload.toolCallId, {
          id: event.payload.toolCallId,
          label: step?.label.replace(/^\w+ing/, "Tried") ?? `Couldn't use ${event.payload.tool}`,
          detail: event.payload.message,
          state: "failed",
        });
        break;
      }
      case "policy.decided":
        if (event.payload.verdict !== "auto") {
          steps.set(event.payload.toolCallId, {
            id: event.payload.toolCallId,
            label: `Not allowed to use ${event.payload.tool}`,
            detail: event.payload.reasons[0] ?? null,
            state: "blocked",
          });
        }
        break;
    }
  }
  return [...steps.values()];
}
