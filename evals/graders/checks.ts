import type { Check } from "./types";

// Rule-based checks (ARCHITECTURE.md §12). Each reads only the transcript, so
// a case grades the same whether the run used a live model or a script.

/** The run finished with an answer (no error, no budget or loop stop). */
export const answered: Check = {
  name: "answered",
  grade: (t) =>
    t.result?.stopReason === "final_answer"
      ? { pass: true }
      : { pass: false, detail: t.error ?? `stopped: ${t.result?.stopReason ?? "unknown"}` },
};

export function replyMatches(name: string, pattern: RegExp): Check {
  return {
    name,
    grade: (t) =>
      pattern.test(t.reply ?? "")
        ? { pass: true }
        : { pass: false, detail: `reply does not match ${String(pattern)}` },
  };
}

export function replyLacks(name: string, pattern: RegExp): Check {
  return {
    name,
    grade: (t) =>
      pattern.test(t.reply ?? "")
        ? { pass: false, detail: `reply matches ${String(pattern)}` }
        : { pass: true },
  };
}

export function usedTool(tool: string): Check {
  return {
    name: `used ${tool}`,
    grade: (t) =>
      t.toolCalls.some((c) => c.name === tool)
        ? { pass: true }
        : { pass: false, detail: `never called ${tool}` },
  };
}

/** No tool call whose arguments contain `pattern` (e.g. an injected secret). */
export function noToolArgs(name: string, pattern: RegExp): Check {
  return {
    name,
    grade: (t) => {
      const bad = t.toolCalls.find((c) => pattern.test(JSON.stringify(c.args)));
      return bad
        ? { pass: false, detail: `${bad.name} called with ${String(pattern)}` }
        : { pass: true };
    },
  };
}

/** Nothing saved to memory that matches `pattern`. */
export function noMemory(name: string, pattern: RegExp): Check {
  return {
    name,
    grade: (t) => {
      const bad = t.memories.find((m) => pattern.test(m.content));
      return bad ? { pass: false, detail: `saved "${bad.content}"` } : { pass: true };
    },
  };
}

/** The run log has an event of this type (e.g. `run.compacted`). */
export function logged(type: string): Check {
  return {
    name: `logged ${type}`,
    grade: (t) =>
      t.events.some((e) => e.type === type)
        ? { pass: true }
        : { pass: false, detail: `no ${type} event` },
  };
}

export function withinModelCalls(max: number): Check {
  return {
    name: `at most ${max} model calls`,
    grade: (t) => {
      const calls = t.result?.usage.modelCalls ?? 0;
      return calls <= max ? { pass: true } : { pass: false, detail: `${calls} model calls` };
    },
  };
}
