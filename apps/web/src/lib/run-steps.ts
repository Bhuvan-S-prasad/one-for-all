import type { RunEvent } from "@ofa/contracts";

// Turn a run's event log into the steps a person cares about: what it looked
// up, read or saved, and whether each worked. The full log is in Activity.

const TOOL_LABELS: Record<string, [doing: string, done: string]> = {
  "web.search": ["Searching the web", "Searched the web"],
  "web.read_url": ["Reading a page", "Read a page"],
  remember: ["Saving to memory", "Saved to memory"],
  recall: ["Checking memory", "Checked memory"],
  "todo.write": ["Planning", "Updated the plan"],
  "browser.open": ["Opening a page", "Opened a page"],
  "browser.snapshot": ["Looking at the page", "Looked at the page"],
  "browser.click": ["Clicking", "Clicked"],
  "browser.type": ["Typing", "Typed"],
  "browser.press": ["Pressing a key", "Pressed a key"],
  "browser.back": ["Going back", "Went back"],
  "shell.run": ["Running a command", "Ran a command"],
  use_saved_login: ["Signing in", "Signed in with a saved login"],
  "artifacts.read": ["Reading saved output", "Read saved output"],
  "files.read": ["Reading a file", "Read a file"],
  "files.write": ["Writing a file", "Wrote a file"],
  "files.list": ["Looking in a folder", "Looked in a folder"],
  "files.send": ["Sending you a file", "Sent you a file"],
  "desktop.open": ["Opening it on the desktop", "Opened it on the desktop"],
  "desktop.snapshot": ["Looking at the desktop", "Looked at the desktop"],
  "desktop.click": ["Clicking on the desktop", "Clicked on the desktop"],
  "desktop.type": ["Typing on the desktop", "Typed on the desktop"],
  "desktop.press": ["Pressing keys", "Pressed keys"],
  "desktop.screenshot": ["Looking at the screen", "Looked at the screen"],
  "desktop.click_at": ["Clicking on the screen", "Clicked on the screen"],
  "desktop.type_text": ["Typing on the screen", "Typed on the screen"],
  delegate_task: ["Handing work to another agent", "Handed work to another agent"],
  message_agent: ["Messaging another agent", "Messaged another agent"],
  schedule_task: ["Scheduling a task for later", "Scheduled a task for later"],
  remind_me: ["Setting a reminder", "Set a reminder"],
  run_skill: ["Opening a skill", "Opened a skill"],
  save_skill: ["Saving a skill", "Saved a skill"],
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
  if (tool === "browser.open" && typeof a.url === "string") {
    try {
      return new URL(a.url).hostname;
    } catch {
      return null;
    }
  }
  if (tool === "browser.type" && typeof a.text === "string") return `“${a.text.slice(0, 40)}”`;
  if (tool === "browser.press" && typeof a.key === "string") return a.key;
  if (tool === "desktop.type" && typeof a.text === "string") return `“${a.text.slice(0, 40)}”`;
  if (tool === "desktop.press" && typeof a.keys === "string") return a.keys;
  if (tool === "shell.run" && typeof a.command === "string") return a.command.slice(0, 80);
  if ((tool.startsWith("files.") || tool === "desktop.open") && typeof a.path === "string") {
    return a.path;
  }
  return null;
}

export function runSteps(events: readonly RunEvent[]): RunStep[] {
  const steps = new Map<string, RunStep>();
  // Calls held for a person: what they would do, and their approval.
  const asked = new Map<string, string>();
  const approvalOf = new Map<string, string>();
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
        if (event.payload.verdict === "deny") {
          steps.set(event.payload.toolCallId, {
            id: event.payload.toolCallId,
            label: `Not allowed to use ${event.payload.tool}`,
            detail: event.payload.reasons[0] ?? null,
            state: "blocked",
          });
        } else if (event.payload.verdict !== "auto") {
          const [doing] = TOOL_LABELS[event.payload.tool] ?? [`Using ${event.payload.tool}`];
          asked.set(event.payload.toolCallId, doing);
          steps.set(event.payload.toolCallId, {
            id: event.payload.toolCallId,
            label: "Waiting for your answer",
            detail: doing,
            state: "active",
          });
        }
        break;
      case "approval.decided": {
        // Approved: the call that follows takes the step over.
        const id = event.payload.approvalId;
        const call = [...asked.keys()].find((k) => approvalOf.get(k) === id);
        if (call && event.payload.decision !== "approved" && event.payload.decision !== "edited") {
          steps.set(call, {
            id: call,
            label: event.payload.decision === "rejected" ? "You said no" : "No answer in time",
            detail: asked.get(call) ?? null,
            state: "blocked",
          });
        }
        break;
      }
      case "approval.requested":
        approvalOf.set(event.payload.toolCallId, event.payload.approvalId);
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
    blocked: events.filter(
      (e) =>
        (e.type === "policy.decided" && e.payload.verdict === "deny") ||
        (e.type === "approval.decided" &&
          e.payload.decision !== "approved" &&
          e.payload.decision !== "edited"),
    ).length,
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
  /** For waiting: on a person's answer, or on the model's capacity. */
  readonly waitingFor?: "you" | "model";
}

const DOING: Record<string, string> = {
  "web.search": "Searching the web",
  "web.read_url": "Reading",
  remember: "Saving to memory",
  recall: "Checking its memory",
  "todo.write": "Planning",
  "browser.open": "Opening",
  "browser.snapshot": "Looking at the page",
  "browser.click": "Clicking on the page",
  "browser.type": "Typing on the page",
  "browser.press": "Pressing a key",
  "browser.back": "Going back a page",
  "shell.run": "Running",
  use_saved_login: "Signing in",
  "artifacts.read": "Reading saved output",
  "files.read": "Reading",
  "files.write": "Writing",
  "files.list": "Looking in",
  "files.send": "Sending",
  "desktop.open": "Opening",
  "desktop.snapshot": "Looking at the desktop",
  "desktop.click": "Clicking on the desktop",
  "desktop.type": "Typing on the desktop",
  "desktop.press": "Pressing keys",
  "desktop.screenshot": "Looking at the screen",
  "desktop.click_at": "Clicking on the screen",
  "desktop.type_text": "Typing on the screen",
};

/** The live phase of an active run, from its latest events. */
export function runPhase(status: string, events: readonly RunEvent[]): RunPhase {
  const last = events.at(-1);
  if (status === "queued" || !last) {
    return { label: "Getting ready", detail: null, kind: "queued", until: null };
  }
  if (status === "waiting" || last.type === "run.waiting") {
    const wait = events.findLast((e) => e.type === "run.waiting");
    const until = wait?.type === "run.waiting" ? (wait.payload.until ?? null) : null;
    if (wait?.type === "run.waiting" && wait.payload.reason === "approval") {
      return { label: "Waiting for you", detail: null, kind: "waiting", until, waitingFor: "you" };
    }
    return {
      label: "Waiting for the model",
      detail: null,
      kind: "waiting",
      until,
      waitingFor: "model",
    };
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
