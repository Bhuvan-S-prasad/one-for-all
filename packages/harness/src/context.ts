import type { LLMMessage, ToolDescriptor } from "@ofa/core";
import { AGENT_IDENTITY, AGENT_VOICE, PLATFORM_RULES, promptRef } from "./prompts";
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
}

export interface ToolCallTurn {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/** One step of the current run: what the model said, or what a tool returned. */
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
    return { role: "user", content: `[another agent] ${message.content}` };
  return null; // System notes are for people, not the model.
}

export function turnMessages(turns: readonly Turn[]): LLMMessage[] {
  return turns.map((turn): LLMMessage =>
    turn.kind === "assistant"
      ? { role: "assistant", content: turn.text, toolCalls: turn.toolCalls }
      : {
          role: "tool",
          toolCallId: turn.toolCallId,
          toolName: turn.toolName,
          content: turn.untrusted ? wrapUntrusted(turn.toolName, turn.content) : turn.content,
        },
  );
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
  // granted set in a stable order; drop the tail if it does not fit.
  const tools: ToolDescriptor[] = [];
  let toolTokens = 0;
  for (const tool of [...input.tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const cost = estimateTools([tool]);
    if (toolTokens + cost > budget.tools) break;
    tools.push(tool);
    toolTokens += cost;
  }
  blocks.tools = toolTokens;

  // Per task: memory and plan.
  const memoryLines: string[] = [];
  let memoryTokens = 0;
  for (const fact of input.memories) {
    const cost = estimateTokens(fact) + 2;
    if (memoryTokens + cost > budget.memory) break;
    memoryLines.push(`- ${fact}`);
    memoryTokens += cost;
  }
  const memory = memoryLines.length
    ? `What you remember (may be out of date; check sources for anything important):\n${memoryLines.join("\n")}`
    : "";
  const plan = input.todos?.length
    ? truncateToTokens(
        `Your plan:\n${input.todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n")}`,
        budget.plan,
      )
    : "";
  blocks.memory = estimateTokens(memory);
  blocks.plan = estimateTokens(plan);

  const system: LLMMessage = {
    role: "system",
    content: [platform, identity, memory, plan].filter(Boolean).join("\n\n"),
  };

  // Volatile: the thread (newest kept, oldest dropped), then this run's steps.
  const history: LLMMessage[] = [];
  let historyTokens = 0;
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const raw = input.history[i];
    const message = raw ? historyMessage(raw, input.agent.id) : null;
    if (!message) continue;
    const cost = estimateMessages([message]);
    // Always keep the latest message: it is usually what the run is about.
    if (history.length > 0 && historyTokens + cost > budget.history) break;
    history.unshift(
      historyTokens + cost > budget.history
        ? { ...message, content: truncateToTokens(message.content, budget.history) }
        : message,
    );
    historyTokens += cost;
  }
  blocks.history = historyTokens;

  const summary: LLMMessage[] = input.summary
    ? [{ role: "user", content: `[Summary of your earlier steps in this task]\n${input.summary}` }]
    : [];
  const turns = turnMessages(input.turns);
  blocks.steps = estimateMessages([...summary, ...turns]);

  const messages = [system, ...history, ...summary, ...turns];
  const total = estimateMessages(messages) + toolTokens;
  const inputBudget = budget.window - budget.output;

  return {
    messages,
    tools,
    maxOutputTokens: budget.output,
    promptVersion: [PLATFORM_RULES, AGENT_IDENTITY, AGENT_VOICE].map(promptRef).join("+"),
    tokens: { total, blocks },
    needsCompaction: total > inputBudget * 0.7 && input.turns.length > 2,
  };
}
