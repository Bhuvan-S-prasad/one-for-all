import type { LLMMessage, ToolDescriptor } from "@ofa/core";

// Token estimates without a tokenizer. Providers and models differ, and a
// tokenizer per model would tie the harness to providers (ADR-0022). Four
// characters per token is close for English and errs on the high side for code.

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessages(messages: readonly LLMMessage[]): number {
  return messages.reduce((sum, message) => {
    const calls = message.role === "assistant" ? JSON.stringify(message.toolCalls ?? []).length : 0;
    return sum + MESSAGE_OVERHEAD + Math.ceil((message.content.length + calls) / CHARS_PER_TOKEN);
  }, 0);
}

export function estimateTools(tools: readonly ToolDescriptor[]): number {
  return estimateTokens(JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema])));
}

/** Cut text to about `tokens` tokens, marking the cut. */
export function truncateToTokens(text: string, tokens: number): string {
  const limit = tokens * CHARS_PER_TOKEN;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 40))}\n…[truncated ${text.length - limit} characters]`;
}
