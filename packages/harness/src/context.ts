import type { LLMImage, LLMMessage, ToolDescriptor } from "@ofa/core";
import {
  AGENT_IDENTITY,
  AGENT_MESSAGE,
  AGENT_VOICE,
  HANDOFF_BRIEF,
  PLATFORM_RULES,
  PROACTIVE_CHECK,
  ROUTINE_RUN,
  SCHEDULED_TASK,
  SCREENSHOT,
  SKILL_IN_USE,
  STEERING,
  TASK_STATE,
  promptRef,
} from "./prompts";
import { estimateMessages, estimateTokens, estimateTools, truncateToTokens } from "./tokens";

// Context assembly (ARCHITECTURE.md §7): the prompt is built from typed
// blocks, each with a token budget scaled from the model's real window, and
// ordered stable → volatile so providers with prompt caching reuse the prefix.

/** A message from the thread, before this run. */
export interface HistoryMessage {
  readonly author: "user" | "agent" | "system";
  /** The agent that wrote it, for agent messages. */
  readonly agentId: string | null;
  readonly content: string;
  /** The writing agent's name, so a shared thread says who said what (M5.04). */
  readonly agentName?: string;
  /**
   * Another agent's brief, framed with `HANDOFF_BRIEF` and shown as the
   * request (M5.01). Its author is another model, not the person.
   */
  readonly handoff?: boolean;
  /**
   * Another agent's message that woke this run, framed with `AGENT_MESSAGE`
   * and shown as the request (M5.03). Its author is another model.
   */
  readonly agentMessage?: boolean;
  /**
   * A routine's or a scheduled task's note, framed with `ROUTINE_RUN` or
   * `SCHEDULED_TASK` and shown as the request (M5.06–07).
   */
  readonly scheduled?: "routine" | "task" | "check";
}

export interface ToolCallTurn {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * One step of the current run: what the model said, what a tool returned, or
 * what the person added while it worked (steering, M5.05).
 */
export type Turn =
  | {
      readonly kind: "assistant";
      readonly text: string;
      readonly toolCalls: readonly ToolCallTurn[];
    }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly untrusted: boolean;
      /**
       * A screenshot shown with the result (DT.11). Only the latest one is
       * kept: the loop drops older images, so the prompt and run state stay small.
       */
      readonly image?: LLMImage;
    }
  | {
      readonly kind: "user";
      readonly text: string;
    };

export interface ContextInput {
  readonly today: string;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly job: string;
    readonly description: string;
    readonly voice: string;
  };
  readonly tools: readonly ToolDescriptor[];
  readonly memories: readonly string[];
  /** Earlier work like this request, from episodic memory (M5.09). */
  readonly episodes?: readonly string[];
  /** A skill the request named with `/slug` (M5.08); its steps join the task. */
  readonly skill?: {
    readonly name: string;
    readonly slug: string;
    readonly steps: readonly string[];
  } | null;
  readonly todos: readonly { readonly text: string; readonly done: boolean }[] | null;
  readonly history: readonly HistoryMessage[];
  /** Compacted summary of earlier steps in this run. */
  readonly summary: string | null;
  readonly turns: readonly Turn[];
}

/** Token budgets per block, from §7's example for a 32,000-token window. */
const BASE_WINDOW = 32_000;
const BASE_BUDGET = {
  platform: 1_200,
  identity: 1_000,
  tools: 4_000,
  plan: 800,
  memory: 2_500,
  history: 10_000,
  untrusted: 6_500,
  output: 6_000,
} as const;

export type ContextBudget = { readonly [K in keyof typeof BASE_BUDGET]: number } & {
  readonly window: number;
};

/**
 * Budgets for a model. Large windows are capped at `maxContextTokens`: free
 * models get slower and less accurate with long prompts, and every token
 * counts against the shared quota.
 */
export function contextBudget(modelWindow: number, maxContextTokens: number): ContextBudget {
  const window = Math.max(4_096, Math.min(modelWindow, maxContextTokens));
  const scale = window / BASE_WINDOW;
  const scaled = Object.fromEntries(
    Object.entries(BASE_BUDGET).map(([block, tokens]) => [block, Math.floor(tokens * scale)]),
  ) as { [K in keyof typeof BASE_BUDGET]: number };
  return { ...scaled, window };
}

export interface AssembledContext {
  readonly messages: LLMMessage[];
  readonly tools: readonly ToolDescriptor[];
  readonly maxOutputTokens: number;
  /** Template versions used, recorded on the trace (M2.22). */
  readonly promptVersion: string;
  readonly tokens: { readonly total: number; readonly blocks: Readonly<Record<string, number>> };
  /** The prompt passed 70% of the input budget: compact before the next call. */
  readonly needsCompaction: boolean;
}

/** Escape a closing tag so untrusted text cannot end its own wrapper. */
function wrapUntrusted(source: string, content: string): string {
  const safe = content.replaceAll("</untrusted>", "&lt;/untrusted&gt;");
  return `<untrusted source="${source}">\n${safe}\n</untrusted>`;
}

function historyMessage(message: HistoryMessage, selfId: string): LLMMessage | null {
  if (message.author === "agent" && message.agentId === selfId) {
    return { role: "assistant", content: message.content };
  }
  if (message.author === "user") return { role: "user", content: message.content };
  if (message.author === "agent")
    return {
      role: "user",
      content: `[${message.agentName ?? "another agent"}] ${message.content}`,
    };
  return null; // System notes are for people, not the model.
}

export function turnMessages(turns: readonly Turn[]): LLMMessage[] {
  const messages: LLMMessage[] = [];
  // A screenshot from a tool result is shown in a user message after that
  // step's results: tool results must follow their call directly.
  let pending: { readonly toolName: string; readonly image: LLMImage } | null = null;
  const flush = () => {
    if (!pending) return;
    messages.push({
      role: "user",
      content: SCREENSHOT.render({ tool: pending.toolName }),
      images: [pending.image],
    });
    pending = null;
  };
  for (const turn of turns) {
    if (turn.kind !== "tool") flush();
    if (turn.kind === "assistant") {
      messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });
    } else if (turn.kind === "user") {
      messages.push({ role: "user", content: STEERING.render({ text: turn.text }) });
    } else {
      messages.push({
        role: "tool",
        toolCallId: turn.toolCallId,
        toolName: turn.toolName,
        content: turn.untrusted ? wrapUntrusted(turn.toolName, turn.content) : turn.content,
      });
      if (turn.image) pending = { toolName: turn.toolName, image: turn.image };
    }
  }
  flush();
  return messages;
}

export function assembleContext(input: ContextInput, budget: ContextBudget): AssembledContext {
  const blocks: Record<string, number> = {};

  // Stable prefix: identical across calls until the agent is edited.
  const platform = PLATFORM_RULES.render({ today: input.today });
  const identity = [
    AGENT_IDENTITY.render(input.agent),
    AGENT_VOICE.render({ voice: input.agent.voice }),
  ].join("\n\n");
  blocks.platform = estimateTokens(platform);
  blocks.identity = estimateTokens(identity);

  // Tool schemas travel separately but count against the window. Keep the
  // granted set in a stable order. App schemas can be large (Notion's
  // create_pages alone is ~2,000 tokens), so tools may borrow up to their
  // budget again from history; a tool that still does not fit is left out,
  // but not the ones after it.
  const tools: ToolDescriptor[] = [];
  let toolTokens = 0;
  for (const tool of [...input.tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const cost = estimateTools([tool]);
    if (toolTokens + cost > budget.tools * 2) continue;
    tools.push(tool);
    toolTokens += cost;
  }
  blocks.tools = toolTokens;
  const borrowed = Math.max(0, toolTokens - budget.tools);

  // Per task: memory and plan.
  const memoryLines: string[] = [];
  let memoryTokens = 0;
  for (const fact of input.memories) {
    const cost = estimateTokens(fact) + 2;
    if (memoryTokens + cost > budget.memory) break;
    memoryLines.push(`- ${fact}`);
    memoryTokens += cost;
  }
  const episodeLines: string[] = [];
  for (const line of input.episodes ?? []) {
    const cost = estimateTokens(line) + 2;
    if (memoryTokens + cost > budget.memory) break;
    episodeLines.push(`- ${line}`);
    memoryTokens += cost;
  }
  const memory = [
    memoryLines.length
      ? `What you remember (may be out of date; check sources for anything important):\n${memoryLines.join("\n")}`
      : "",
    episodeLines.length ? `Earlier work like this:\n${episodeLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  // A skill the person named (M5.08): its steps, within the plan budget.
  const skill = input.skill
    ? truncateToTokens(
        SKILL_IN_USE.render({
          name: input.skill.name,
          slug: input.skill.slug,
          steps: input.skill.steps,
        }),
        budget.plan,
      )
    : "";
  // Task and plan, restated every step (§7): the latest request, the agent's
  // todo list, and its notes from compacted steps. Half the plan budget goes
  // to the request, half to the todo list; the notes count against history.
  const latestRequest = [...input.history].reverse().find((m) => m.author === "user");
  // What the person added while the run worked belongs to the task too (M5.05).
  const added = input.turns.flatMap((t) => (t.kind === "user" ? [`Then: ${t.text}`] : []));
  const requestText = [latestRequest?.content ?? "", ...added].filter(Boolean).join("\n");
  const task = requestText ? truncateToTokens(requestText, Math.floor(budget.plan / 2)) : "";
  const plan = input.todos?.length
    ? truncateToTokens(
        `Your plan:\n${input.todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n")}`,
        Math.floor(budget.plan / 2),
      )
    : "";
  const notes = input.summary
    ? truncateToTokens(input.summary, Math.floor(budget.history * 0.3))
    : "";
  const taskBlock = TASK_STATE.render({ task, plan, notes });
  blocks.memory = estimateTokens(memory);
  blocks.skill = skill ? estimateTokens(skill) : 0;
  blocks.notes = notes ? estimateTokens(notes) : 0;
  blocks.plan = estimateTokens(taskBlock) - blocks.notes;

  const system: LLMMessage = {
    role: "system",
    content: [platform, identity, memory, skill, taskBlock].filter(Boolean).join("\n\n"),
  };

  // Volatile: the thread (newest kept, oldest dropped), then this run's steps.
  const history: LLMMessage[] = [];
  let historyTokens = 0;
  const historyBudget = budget.history - blocks.notes - borrowed;
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const raw = input.history[i];
    const message = raw ? historyMessage(raw, input.agent.id) : null;
    if (!message) continue;
    const cost = estimateMessages([message]);
    // Always keep the latest message: it is usually what the run is about.
    if (history.length > 0 && historyTokens + cost > historyBudget) break;
    history.unshift(
      historyTokens + cost > historyBudget
        ? { ...message, content: truncateToTokens(message.content, historyBudget) }
        : message,
    );
    historyTokens += cost;
  }
  blocks.history = historyTokens;

  const turns = turnMessages(input.turns);
  blocks.steps = estimateMessages(turns);

  const messages = [system, ...history, ...turns];
  const total = estimateMessages(messages) + toolTokens;
  const inputBudget = budget.window - budget.output;

  return {
    messages,
    tools,
    maxOutputTokens: budget.output,
    promptVersion: [
      PLATFORM_RULES,
      AGENT_IDENTITY,
      AGENT_VOICE,
      TASK_STATE,
      ...(input.history.some((m) => m.handoff) ? [HANDOFF_BRIEF] : []),
      ...(input.history.some((m) => m.agentMessage) ? [AGENT_MESSAGE] : []),
      ...(input.history.some((m) => m.scheduled === "routine") ? [ROUTINE_RUN] : []),
      ...(input.history.some((m) => m.scheduled === "task") ? [SCHEDULED_TASK] : []),
      ...(input.history.some((m) => m.scheduled === "check") ? [PROACTIVE_CHECK] : []),
      ...(input.turns.some((t) => t.kind === "user") ? [STEERING] : []),
      ...(input.turns.some((t) => t.kind === "tool" && t.image) ? [SCREENSHOT] : []),
      ...(input.skill ? [SKILL_IN_USE] : []),
    ]
      .map(promptRef)
      .join("+"),
    tokens: { total, blocks },
    needsCompaction: total > inputBudget * 0.7 && input.turns.length > 2,
  };
}
