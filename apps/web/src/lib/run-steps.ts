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

// ── What a run is doing, and what it used (UX.07, UX.09) ─────────────────────

/** A page the agent opened, numbered in reading order once it was read. */
export interface RunSource {
  readonly url: string;
  readonly host: string;
  /** The page's title, from the start of what the tool returned. */
  readonly title: string | null;
  readonly state: "reading" | "read" | "failed";
  /** 1, 2, 3… for pages read; null for pages being read or that failed. */
  readonly n: number | null;
  readonly error: string | null;
}

/** Same page, however the address was written: no fragment, `www.` or trailing slash. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Pages the run read, from its tool calls (not from addresses the model
 * wrote), so a made-up link never looks like a source.
 */
export function runSources(events: readonly RunEvent[]): RunSource[] {
  const byCall = new Map<string, RunSource>();
  const seen = new Set<string>();
  let n = 0;
  for (const event of events) {
    if (event.type === "tool.called" && event.payload.tool === "web.read_url") {
      const url = (event.payload.args as { url?: unknown } | null)?.url;
      if (typeof url !== "string") continue;
      byCall.set(event.payload.toolCallId, {
        url,
        host: hostOf(url),
        title: null,
        state: "reading",
        n: null,
        error: null,
      });
    } else if (event.type === "tool.completed" && event.payload.tool === "web.read_url") {
      const source = byCall.get(event.payload.toolCallId);
      if (!source) continue;
      // The tool returns "Source: <final address>\n\n# <title>\n\n<text>".
      const finalUrl = /^Source: (\S+)/.exec(event.payload.preview)?.[1];
      const title = /^# (.+)$/m.exec(event.payload.preview)?.[1]?.trim() ?? null;
      const key = pageKey(finalUrl ?? source.url);
      const again = seen.has(key);
      seen.add(key);
      byCall.set(event.payload.toolCallId, {
        ...source,
        url: finalUrl ?? source.url,
        host: hostOf(finalUrl ?? source.url),
        title,
        state: "read",
        // Reading on into the same page (`from`) is not a new source.
        n: again ? null : ++n,
      });
    } else if (event.type === "tool.failed" && event.payload.tool === "web.read_url") {
      const source = byCall.get(event.payload.toolCallId);
      if (source) {
        byCall.set(event.payload.toolCallId, {
          ...source,
          state: "failed",
          error: event.payload.message,
        });
      }
    }
  }
  return [...byCall.values()].filter((s) => s.state !== "read" || s.n !== null);
}

/** The numbered source a link points at, if the run read that page. */
export function sourceFor(sources: readonly RunSource[], href: string): RunSource | null {
  const key = pageKey(href);
  return sources.find((s) => s.n !== null && pageKey(s.url) === key) ?? null;
}

export interface RunSummary {
  readonly searches: number;
  readonly pagesRead: number;
  readonly failed: number;
  readonly compacted: boolean;
  readonly blocked: number;
}

export function runSummary(events: readonly RunEvent[]): RunSummary {
  const sources = runSources(events);
  return {
    searches: events.filter((e) => e.type === "tool.called" && e.payload.tool === "web.search")
      .length,
    pagesRead: sources.filter((s) => s.state === "read").length,
    failed: events.filter((e) => e.type === "tool.failed").length,
    compacted: events.some((e) => e.type === "run.compacted"),
    blocked: events.filter((e) => e.type === "policy.decided" && e.payload.verdict !== "auto")
      .length,
  };
}

/** "1 search · read 6 pages · 1 couldn't load", empty when nothing was used. */
export function summaryLine(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.searches)
    parts.push(summary.searches === 1 ? "1 search" : `${summary.searches} searches`);
  if (summary.pagesRead)
    parts.push(summary.pagesRead === 1 ? "read 1 page" : `read ${summary.pagesRead} pages`);
  if (summary.failed) parts.push(`${summary.failed} couldn't load`);
  if (summary.blocked) parts.push(`${summary.blocked} not allowed`);
  return parts.join(" · ");
}

export interface RunPhase {
  /** What it is doing, in plain words: "Searching the web". */
  readonly label: string;
  /** The target, when there is one: a query or a site. */
  readonly detail: string | null;
  readonly kind: "queued" | "thinking" | "working" | "waiting";
  /** For waiting: when it expects to carry on. */
  readonly until: string | null;
}

const DOING: Record<string, string> = {
  "web.search": "Searching the web",
  "web.read_url": "Reading",
  remember: "Saving to memory",
  recall: "Checking its memory",
  "todo.write": "Planning",
};

/** The live phase of an active run, from its latest events. */
export function runPhase(status: string, events: readonly RunEvent[]): RunPhase {
  const last = events.at(-1);
  if (status === "queued" || !last) {
    return { label: "Getting ready", detail: null, kind: "queued", until: null };
  }
  if (status === "waiting" || last.type === "run.waiting") {
    const until = last.type === "run.waiting" ? (last.payload.until ?? null) : null;
    return { label: "Waiting for the model", detail: null, kind: "waiting", until };
  }
  // The newest tool call that has not finished yet is what it is doing.
  const open = new Map<string, Extract<RunEvent, { type: "tool.called" }>>();
  for (const e of events) {
    if (e.type === "tool.called") open.set(e.payload.toolCallId, e);
    if (e.type === "tool.completed" || e.type === "tool.failed") open.delete(e.payload.toolCallId);
  }
  const running = [...open.values()].at(-1);
  if (running) {
    const tool = running.payload.tool;
    const detail = detailFor(tool, running.payload.args);
    return {
      label: DOING[tool] ?? `Using ${tool}`,
      detail: tool === "web.read_url" ? (detail ?? "a page") : detail,
      kind: "working",
      until: null,
    };
  }
  if (last.type === "run.compacted") {
    return { label: "Tidying its notes to make room", detail: null, kind: "thinking", until: null };
  }
  const usedTools = events.some((e) => e.type === "tool.completed");
  return {
    label: usedTools ? "Thinking about what it found" : "Thinking it over",
    detail: null,
    kind: "thinking",
    until: null,
  };
}

/** The agent's latest plan, from its last `todo.write`. */
export function runPlan(events: readonly RunEvent[]): { text: string; done: boolean }[] | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === "tool.called" && e.payload.tool === "todo.write") {
      const items = (e.payload.args as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) continue;
      return items
        .filter((x): x is { text: string; done?: boolean } => typeof x?.text === "string")
        .map((x) => ({ text: x.text, done: !!x.done }));
    }
  }
  return null;
}
