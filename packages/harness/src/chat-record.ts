import type { RunStopReason } from "@ofa/contracts";
import type { ChatLedgerEntry, ChatPlanItem, ChatRecord, ToolDescriptor } from "@ofa/core";
import { estimateTokens } from "./tokens";

// The chat record (ADR-0045): what an agent did in a chat, kept so the next
// run there carries on instead of starting over. Built by the harness from
// tool results, never written by the model, and rebuilt the same way on
// replay because it comes only from step results.

/** Entries a record keeps; searches and pages read go first when it is full. */
export const LEDGER_LIMIT = 40;
const ACTION_CHARS = 300;
const HANDOFF_ANSWER_CHARS = 1_200;

/** Bookkeeping every agent has: not work the person asked for. */
const NOT_WORK = new Set([
  "todo.write",
  "recall",
  "remember",
  "load_toolkit",
  "artifacts.read",
  "run_skill",
  "delegate_task",
]);

/** Tools that look something up, kept by what was looked up. */
const SEARCHES: Record<string, string> = { "web.search": "query" };
const READS: Record<string, string> = { "web.read_url": "url", "browser.open": "url" };

/** Long text arguments say little in one line: the rest are shown. */
const BULKY = new Set(["content", "body", "text", "html", "markdown", "data", "brief", "message"]);

function flat(text: string, length: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > length ? `${one.slice(0, length - 1)}…` : one;
}

function argsLine(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (BULKY.has(key)) continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    parts.push(`${key}: ${flat(String(value), 60)}`);
    if (parts.length === 3) break;
  }
  return parts.join(", ");
}

/**
 * What one finished tool call adds to the record, if anything. Results are
 * quoted only when they came from inside the system; outside content is
 * named, never copied (its words could carry instructions).
 */
export function ledgerEntry(
  call: { readonly name: string; readonly args: unknown },
  result: { readonly ok: boolean; readonly content: string; readonly untrusted: boolean },
  tool: ToolDescriptor | undefined,
  runId: string,
): ChatLedgerEntry | null {
  if (!result.ok || NOT_WORK.has(call.name)) return null;
  const args = (call.args ?? {}) as Record<string, unknown>;
  const searched = SEARCHES[call.name];
  if (searched) {
    const value = args[searched];
    return typeof value === "string" && value.trim()
      ? { kind: "search", text: flat(value, 160), runId }
      : null;
  }
  const read = READS[call.name];
  if (read) {
    const value = args[read];
    return typeof value === "string" && value.trim()
      ? { kind: "read", text: flat(value, 300), runId }
      : null;
  }
  if (tool?.annotations.readOnly) return null;
  const said = argsLine(args);
  const outcome = result.untrusted ? "done" : flat(result.content, 160) || "done";
  return {
    kind: "action",
    text: flat(`${call.name}${said ? ` (${said})` : ""} → ${outcome}`, ACTION_CHARS),
    runId,
  };
}

/** A handoff and what came back (M5.01); a tainted child's answer stays outside content. */
export function handoffEntry(
  args: unknown,
  result: { readonly content: string; readonly untrusted: boolean },
  runId: string,
): ChatLedgerEntry {
  const { agent, brief } = (args ?? {}) as { agent?: string; brief?: string };
  let parsed: { agent?: string; status?: string; answer?: string; note?: string } = {};
  try {
    parsed = JSON.parse(result.content) as typeof parsed;
  } catch {
    // A refusal ("Not done: …") is plain text.
  }
  const who = parsed.agent ?? agent ?? "another agent";
  const status = parsed.status ?? flat(result.content, 160);
  const answer = parsed.answer ? `: ${flat(parsed.answer, HANDOFF_ANSWER_CHARS)}` : "";
  return {
    kind: "handoff",
    text: `${who} was asked “${flat(brief ?? "", 160)}” → ${status}${answer}`,
    ...(answer && result.untrusted ? { untrusted: true } : {}),
    // So a later run in this chat can still pass it on (include_results_from).
    ...(agent ? { agent: agent.trim().replace(/^@/, "").toLowerCase() } : {}),
    ...(parsed.answer ? { answer: parsed.answer.slice(0, HANDOFF_ANSWER_CHARS) } : {}),
    runId,
  };
}

/**
 * Add entries to a ledger. A search or page seen again moves to the end
 * instead of repeating; when it is full, searches and pages read go first.
 */
export function addToLedger(
  ledger: readonly ChatLedgerEntry[],
  entries: readonly ChatLedgerEntry[],
  limit = LEDGER_LIMIT,
): ChatLedgerEntry[] {
  let next = [...ledger];
  for (const entry of entries) {
    if (entry.kind === "search" || entry.kind === "read") {
      next = next.filter((e) => !(e.kind === entry.kind && e.text === entry.text));
    }
    next.push(entry);
  }
  while (next.length > limit) {
    const lookup = next.findIndex((e) => e.kind === "search" || e.kind === "read");
    next.splice(lookup >= 0 ? lookup : 0, 1);
  }
  return next;
}

/**
 * The plan a run starts with: the last run's, when it stopped before
 * answering and left something open. A finished task's plan stays history.
 */
export function carriedPlan(record: ChatRecord | null): ChatPlanItem[] | null {
  if (!record?.plan?.length || record.stopReason === "final_answer") return null;
  return record.plan.some((item) => !item.done) ? record.plan.map((item) => ({ ...item })) : null;
}

const ENDINGS: Partial<Record<RunStopReason, string>> = {
  final_answer: "You answered.",
  step_budget: "You stopped at your step limit before finishing.",
  token_budget: "You stopped at your token budget before finishing.",
  cost_budget: "You stopped at your cost budget before finishing.",
  loop_detected: "You stopped because you were repeating a step.",
};

function ending(stopReason: string | null): string {
  if (stopReason === null)
    return "Your last run ended before it finished (it failed or was stopped).";
  return ENDINGS[stopReason as RunStopReason] ?? "Your last run ended before it finished.";
}

function wrapOutside(text: string): string {
  return `<untrusted source="an earlier handoff">${text.replaceAll("</untrusted>", "&lt;/untrusted&gt;")}</untrusted>`;
}

/**
 * The record as the next run reads it, within `budget` tokens: the oldest
 * searches and pages go first, then the oldest of the rest.
 */
export function recordLines(
  record: ChatRecord,
  budget: number,
  options: { readonly withPlan: boolean },
): {
  readonly ended: string;
  readonly plan: string;
  readonly done: string;
  readonly notes: string;
} {
  const plan =
    options.withPlan && record.plan?.length
      ? record.plan.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n")
      : "";
  const notes = record.notes ? flat(record.notes, 2_000) : "";
  const render = (ledger: readonly ChatLedgerEntry[]) => {
    const work = ledger
      .filter((e) => e.kind === "action" || e.kind === "handoff")
      .map((e) => {
        const line = e.kind === "handoff" ? `Handed off: ${e.text}` : e.text;
        return `- ${e.untrusted ? wrapOutside(line) : line}`;
      });
    const searched = ledger.filter((e) => e.kind === "search").map((e) => `“${e.text}”`);
    const read = ledger.filter((e) => e.kind === "read").map((e) => e.text);
    return [
      ...work,
      searched.length ? `- Searched: ${searched.join("; ")}` : "",
      read.length ? `- Read: ${read.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };
  const ledger = [...record.ledger];
  let done = render(ledger);
  const fixed = estimateTokens(plan) + estimateTokens(notes) + 60;
  while (ledger.length > 0 && fixed + estimateTokens(done) > budget) {
    const lookup = ledger.findIndex((e) => e.kind === "search" || e.kind === "read");
    ledger.splice(lookup >= 0 ? lookup : 0, 1);
    done = render(ledger);
  }
  return { ended: ending(record.stopReason), plan, done, notes };
}

/** The record carries a quote from outside: the run that reads it is tainted (ADR-0013). */
export function quotesOutside(record: ChatRecord | null): boolean {
  return record?.ledger.some((e) => e.untrusted) ?? false;
}

/**
 * What a run stopped by a budget or a loop tells the person (ADR-0045): what
 * it did, what is left, and how to carry on. No model call: the record says it.
 */
export function stopReply(
  note: string,
  done: readonly ChatLedgerEntry[],
  plan: readonly ChatPlanItem[] | null,
  /** What it wrote in its last call, without tools, when it had something (TC.09). */
  answer: string | null = null,
): string {
  const work = done
    .filter((e) => e.kind === "action" || e.kind === "handoff")
    .slice(-6)
    .map((e) =>
      e.kind === "handoff" ? `- Handed off: ${flat(e.text, 200)}` : `- ${flat(e.text, 200)}`,
    );
  const searches = done.filter((e) => e.kind === "search").length;
  const reads = done.filter((e) => e.kind === "read").length;
  if (searches || reads) {
    const looked = [
      searches ? `${searches} search${searches === 1 ? "" : "es"}` : "",
      reads ? `${reads} page${reads === 1 ? "" : "s"} read` : "",
    ]
      .filter(Boolean)
      .join(", ");
    work.push(`- Looked things up: ${looked}`);
  }
  const left = (plan ?? [])
    .filter((t) => !t.done)
    .slice(0, 6)
    .map((t) => `- ${t.text}`);
  return [
    answer ?? "",
    note,
    // The answer says what it found; without one, the record does.
    !answer && work.length ? `Done so far:\n${work.join("\n")}` : "",
    left.length ? `Still to do:\n${left.join("\n")}` : "",
    "Reply “continue” and I'll pick up from here.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One line for the episode of a run that stopped: what it did and what is left. */
export function progressLine(
  done: readonly ChatLedgerEntry[],
  plan: readonly ChatPlanItem[] | null,
): string {
  const work = done
    .filter((e) => e.kind === "action" || e.kind === "handoff")
    .map((e) => flat(e.text, 80));
  const looked = done.filter((e) => e.kind === "search" || e.kind === "read").length;
  const left = (plan ?? []).filter((t) => !t.done).map((t) => t.text);
  return [
    work.length ? `did ${work.slice(-3).join("; ")}` : "",
    looked ? `${looked} lookups` : "",
    left.length ? `left: ${left.slice(0, 3).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join(" — ");
}
