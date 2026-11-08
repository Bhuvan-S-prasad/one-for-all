import type { Agent, RunEvent } from "@ofa/contracts";

// Turn a run's event log into the steps a person cares about: what it looked
// up, read, saved or handed on, and whether each worked. The full log is in
// Activity. The trail reads like a person's notes (Perplexity's steps,
// Claude's tool calls): what was done to what, quiet when it worked, plain
// words when it didn't.

/** What a step is doing, what it did, and what it couldn't do ("Couldn't …"). */
const TOOL_LABELS: Record<string, [doing: string, done: string, base: string]> = {
  "web.search": ["Searching the web", "Searched the web", "search the web"],
  "web.read_url": ["Reading a page", "Read a page", "read a page"],
  remember: ["Saving to memory", "Saved to memory", "save to memory"],
  recall: ["Checking memory", "Checked memory", "check memory"],
  "todo.write": ["Planning", "Updated the plan", "update the plan"],
  "browser.open": ["Opening a page", "Opened a page", "open a page"],
  "browser.snapshot": ["Looking at the page", "Looked at the page", "look at the page"],
  "browser.click": ["Clicking", "Clicked", "click"],
  "browser.type": ["Typing", "Typed", "type"],
  "browser.press": ["Pressing a key", "Pressed a key", "press a key"],
  "browser.back": ["Going back", "Went back", "go back"],
  "shell.run": ["Running a command", "Ran a command", "run a command"],
  use_saved_login: ["Signing in", "Signed in with a saved login", "sign in"],
  "artifacts.read": ["Reading saved output", "Read saved output", "read saved output"],
  "files.read": ["Reading a file", "Read a file", "read a file"],
  "files.write": ["Writing a file", "Wrote a file", "write a file"],
  "files.list": ["Looking in a folder", "Looked in a folder", "look in a folder"],
  "files.send": ["Sending you a file", "Sent you a file", "send you a file"],
  "desktop.open": ["Opening it on the desktop", "Opened it on the desktop", "open it"],
  "desktop.snapshot": ["Looking at the desktop", "Looked at the desktop", "see the desktop"],
  "desktop.click": ["Clicking on the desktop", "Clicked on the desktop", "click"],
  "desktop.type": ["Typing on the desktop", "Typed on the desktop", "type"],
  "desktop.press": ["Pressing keys", "Pressed keys", "press keys"],
  "desktop.screenshot": ["Looking at the screen", "Looked at the screen", "see the screen"],
  "desktop.click_at": ["Clicking on the screen", "Clicked on the screen", "click"],
  "desktop.type_text": ["Typing on the screen", "Typed on the screen", "type"],
  schedule_task: ["Scheduling a task for later", "Scheduled a task for later", "schedule it"],
  remind_me: ["Setting a reminder", "Set a reminder", "set a reminder"],
  run_skill: ["Opening a skill", "Opened a skill", "open the skill"],
  save_skill: ["Saving a skill", "Saved a skill", "save the skill"],
};

export interface RunStep {
  readonly id: string;
  /** The tool behind the step, for its icon; null for a person's answer. */
  readonly tool: string | null;
  readonly label: string;
  readonly detail: string | null;
  readonly state: "done" | "active" | "failed" | "blocked";
  /** How long the call took, once it finished. */
  readonly durationMs: number | null;
}

/** Agents by slug, so a handoff says who: "Asked Researcher". */
export type AgentNames = ReadonlyMap<string, string>;

export function agentNames(agents: readonly Agent[] | undefined): AgentNames {
  return new Map((agents ?? []).map((a) => [a.slug.toLowerCase(), a.name]));
}

function oneLine(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function agentName(slug: unknown, names: AgentNames | undefined): string {
  if (typeof slug !== "string" || !slug.trim()) return "another agent";
  const key = slug.trim().replace(/^@/, "").toLowerCase();
  return names?.get(key) ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " ");
}

function labelsFor(
  tool: string,
  args: unknown,
  names: AgentNames | undefined,
): [doing: string, done: string, base: string] {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "delegate_task") {
    const who = agentName(a.agent, names);
    return [`Asking ${who}`, `Asked ${who}`, `ask ${who}`];
  }
  if (tool === "message_agent") {
    const who = agentName(a.agent ?? a.to, names);
    return [`Messaging ${who}`, `Messaged ${who}`, `message ${who}`];
  }
  if (tool === "ask_group") return ["Asking the group", "Asked the group", "ask the group"];
  const known = TOOL_LABELS[tool];
  if (known) return known;
  // App tools (gmail.create_draft): the action in words, under the app's name.
  const [app, action] = tool.includes(".") ? tool.split(".", 2) : [null, tool];
  const words = (action ?? tool).replace(/_/g, " ");
  const where = app ? ` in ${app.charAt(0).toUpperCase()}${app.slice(1)}` : "";
  return [
    `Using ${tool}`,
    `${words.charAt(0).toUpperCase()}${words.slice(1)}${where}`,
    `use ${tool}`,
  ];
}

function hostOrNull(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function detailFor(tool: string, args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "web.search" && typeof a.query === "string") return a.query;
  if (tool === "web.read_url" || tool === "browser.open") return hostOrNull(a.url);
  if (tool === "remember" && typeof a.fact === "string") return a.fact;
  if (tool === "recall" && typeof a.query === "string") return a.query;
  if (tool === "browser.type" && typeof a.text === "string") return `“${a.text.slice(0, 40)}”`;
  if (tool === "browser.press" && typeof a.key === "string") return a.key;
  if (tool === "desktop.type" && typeof a.text === "string") return `“${a.text.slice(0, 40)}”`;
  if (tool === "desktop.press" && typeof a.keys === "string") return a.keys;
  if (tool === "shell.run" && typeof a.command === "string") return a.command.slice(0, 80);
  if ((tool.startsWith("files.") || tool === "desktop.open") && typeof a.path === "string") {
    return a.path;
  }
  if (tool === "delegate_task" && typeof a.brief === "string") return oneLine(a.brief, 140);
  if (tool === "message_agent" && typeof a.message === "string") return oneLine(a.message, 140);
  if (tool === "ask_group" && typeof a.question === "string") return oneLine(a.question, 140);
  if (tool === "todo.write" && Array.isArray(a.items)) {
    const items = a.items as { done?: unknown }[];
    const done = items.filter((x) => x?.done === true).length;
    return `${done} of ${items.length} done`;
  }
  if (tool === "artifacts.read" && typeof a.uri === "string") return a.uri;
  if (typeof a.subject === "string") return a.subject;
  return null;
}

/**
 * A failure in plain words: what went wrong, not the validator's message.
 * Unknown shapes pass through, shortened.
 */
export function plainError(message: string): string {
  const unknown = /^Unknown tool:\s*(.+)$/i.exec(message.trim());
  if (unknown) return `“${unknown[1]}” isn't one of its tools`;
  const tooBig = /^(\w+):\s*Too big: expected \w+ to have <=\s*([\d,]+) (\w+)/i.exec(message);
  if (tooBig) {
    const limit = Number(tooBig[2]!.replace(/,/g, "")).toLocaleString("en");
    return `The ${tooBig[1]} was too long (the limit is ${limit} ${tooBig[3]})`;
  }
  const tooSmall = /^(\w+):\s*Too small/i.exec(message);
  if (tooSmall) return `The ${tooSmall[1]} was missing or empty`;
  const missing = /^(\w+):\s*(Required|Invalid input: expected \w+, received undefined)/i.exec(
    message,
  );
  if (missing) return `It left out the ${missing[1]}`;
  return oneLine(message, 200);
}

export function runSteps(events: readonly RunEvent[], names?: AgentNames): RunStep[] {
  const steps = new Map<string, RunStep>();
  const bases = new Map<string, string>();
  const argsOf = new Map<string, unknown>();
  // Calls held for a person: what they would do, and their approval.
  const asked = new Map<string, string>();
  const approvalOf = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case "tool.called": {
        const { tool, args, toolCallId } = event.payload;
        const [doing, , base] = labelsFor(tool, args, names);
        bases.set(toolCallId, base);
        argsOf.set(toolCallId, args);
        steps.set(toolCallId, {
          id: toolCallId,
          tool,
          label: doing,
          detail: detailFor(tool, args),
          state: "active",
          durationMs: null,
        });
        break;
      }
      case "tool.completed": {
        const step = steps.get(event.payload.toolCallId);
        if (!step) break;
        const [, done] = labelsFor(event.payload.tool, argsOf.get(step.id), names);
        steps.set(step.id, {
          ...step,
          label: done,
          state: "done",
          durationMs: event.payload.durationMs,
        });
        break;
      }
      case "tool.failed": {
        const { toolCallId, tool, message, durationMs } = event.payload;
        const unknown = /^Unknown tool/i.test(message);
        const base = bases.get(toolCallId) ?? labelsFor(tool, undefined, names)[2];
        steps.set(toolCallId, {
          id: toolCallId,
          tool,
          label: unknown ? "Reached for a tool it doesn't have" : `Couldn't ${base}`,
          detail: plainError(message),
          state: "failed",
          durationMs,
        });
        break;
      }
      case "policy.decided":
        if (event.payload.verdict === "deny") {
          steps.set(event.payload.toolCallId, {
            id: event.payload.toolCallId,
            tool: event.payload.tool,
            label: `Not allowed to ${labelsFor(event.payload.tool, undefined, names)[2]}`,
            detail: event.payload.reasons[0] ?? null,
            state: "blocked",
            durationMs: null,
          });
        } else if (event.payload.verdict !== "auto") {
          const [doing] = labelsFor(event.payload.tool, undefined, names);
          asked.set(event.payload.toolCallId, doing);
          steps.set(event.payload.toolCallId, {
            id: event.payload.toolCallId,
            tool: null,
            label: "Waiting for your answer",
            detail: doing,
            state: "active",
            durationMs: null,
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
            tool: null,
            label: event.payload.decision === "rejected" ? "You said no" : "No answer in time",
            detail: asked.get(call) ?? null,
            state: "blocked",
            durationMs: null,
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

/** Lookups that read as one step when they come in a row: "Searched the web · 4". */
const GROUPED = new Set([
  "web.search",
  "web.read_url",
  "recall",
  "files.read",
  "files.list",
  "browser.snapshot",
  "desktop.snapshot",
  "desktop.screenshot",
]);

/** One row of the trail: a step, or a run of the same lookup with what each looked at. */
export interface StepGroup {
  readonly id: string;
  readonly tool: string | null;
  readonly label: string;
  readonly state: RunStep["state"];
  /** One step's detail, or each lookup's target in a group. */
  readonly details: readonly string[];
  readonly count: number;
  readonly durationMs: number | null;
}

export function groupSteps(steps: readonly RunStep[]): StepGroup[] {
  const rows: StepGroup[] = [];
  for (const step of steps) {
    const last = rows.at(-1);
    if (
      last &&
      step.state === "done" &&
      last.state === "done" &&
      step.tool !== null &&
      step.tool === last.tool &&
      GROUPED.has(step.tool)
    ) {
      rows[rows.length - 1] = {
        ...last,
        details: step.detail ? [...last.details, step.detail] : last.details,
        count: last.count + 1,
        durationMs: (last.durationMs ?? 0) + (step.durationMs ?? 0),
      };
      continue;
    }
    rows.push({
      id: step.id,
      tool: step.tool,
      label: step.label,
      state: step.state,
      details: step.detail ? [step.detail] : [],
      count: 1,
      durationMs: step.durationMs,
    });
  }
  return rows;
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
  /** Teammates it handed work to, each counted once. */
  readonly agentsAsked: number;
  readonly searches: number;
  readonly pagesRead: number;
  /** Pages that wouldn't load. */
  readonly failed: number;
  /** Other steps that didn't work. */
  readonly stepsFailed: number;
  readonly compacted: boolean;
  readonly blocked: number;
}

export function runSummary(events: readonly RunEvent[]): RunSummary {
  const sources = runSources(events);
  const asked = new Set(
    events.flatMap((e) =>
      e.type === "tool.called" && e.payload.tool === "delegate_task"
        ? [String((e.payload.args as { agent?: unknown } | null)?.agent ?? "").toLowerCase()]
        : [],
    ),
  );
  const failed = events.filter((e) => e.type === "tool.failed");
  return {
    agentsAsked: asked.size,
    searches: events.filter((e) => e.type === "tool.called" && e.payload.tool === "web.search")
      .length,
    pagesRead: sources.filter((s) => s.state === "read").length,
    failed: failed.filter((e) => e.payload.tool === "web.read_url").length,
    stepsFailed: failed.filter((e) => e.payload.tool !== "web.read_url").length,
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

/** "asked 2 agents · 1 search · read 6 pages · 1 couldn't load", empty when nothing was used. */
export function summaryLine(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.agentsAsked)
    parts.push(summary.agentsAsked === 1 ? "asked 1 agent" : `asked ${summary.agentsAsked} agents`);
  if (summary.searches)
    parts.push(summary.searches === 1 ? "1 search" : `${summary.searches} searches`);
  if (summary.pagesRead)
    parts.push(summary.pagesRead === 1 ? "read 1 page" : `read ${summary.pagesRead} pages`);
  if (summary.failed) parts.push(`${summary.failed} couldn't load`);
  if (summary.stepsFailed)
    parts.push(
      summary.stepsFailed === 1 ? "1 step didn't work" : `${summary.stepsFailed} steps didn't work`,
    );
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
  /** For working: the tool it is using. */
  readonly tool?: string;
  /** For thinking: it has used tools already, or it is making room. */
  readonly after?: "tools" | "compaction";
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
      tool,
    };
  }
  if (last.type === "run.compacted") {
    return {
      label: "Tidying its notes to make room",
      detail: null,
      kind: "thinking",
      until: null,
      after: "compaction",
    };
  }
  const usedTools = events.some((e) => e.type === "tool.completed");
  return {
    label: usedTools ? "Thinking about what it found" : "Thinking it over",
    detail: null,
    kind: "thinking",
    until: null,
    ...(usedTools ? { after: "tools" as const } : {}),
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
