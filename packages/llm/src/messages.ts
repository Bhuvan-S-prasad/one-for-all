import type { LLMMessage, ToolDescriptor } from "@ofa/core";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";

// Translate the harness's provider-neutral messages and tools into AI SDK
// shapes. The AI SDK in turn speaks each provider's wire format.

/**
 * Most providers accept only `[a-zA-Z0-9_-]{1,64}` as a function name, so
 * `web.search` travels as `web_search`. The map turns names back when the
 * model calls a tool.
 */
export class ToolNames {
  private readonly toWire = new Map<string, string>();
  private readonly fromWire = new Map<string, string>();

  constructor(names: readonly string[]) {
    for (const name of names) {
      const base = ToolNames.wireName(name);
      let wire = base;
      for (let n = 2; this.fromWire.has(wire); n += 1) wire = `${base.slice(0, 60)}_${n}`;
      this.toWire.set(name, wire);
      this.fromWire.set(wire, name);
    }
  }

  static wireName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
  }

  wire(name: string): string {
    return this.toWire.get(name) ?? ToolNames.wireName(name);
  }

  /** The tool's real name, or undefined if the model made one up. */
  original(wire: string): string | undefined {
    return this.fromWire.get(wire);
  }
}

export function toToolSet(tools: readonly ToolDescriptor[], names: ToolNames): ToolSet {
  return Object.fromEntries(
    tools.map((descriptor) => [
      names.wire(descriptor.name),
      // No `execute`: the model only proposes calls. The harness runs them
      // through policy and the tool executor (hard rule 5).
      tool({
        description: descriptor.description,
        inputSchema: jsonSchema(descriptor.inputSchema),
      }),
    ]),
  );
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function toModelMessages(messages: readonly LLMMessage[], names: ToolNames): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        if (!message.images?.length) return { role: "user", content: message.content };
        return {
          role: "user",
          content: [
            { type: "text" as const, text: message.content },
            ...message.images.map((image) => ({
              // A file part with an image type: the AI SDK's current form for images.
              type: "file" as const,
              data: image.data,
              mediaType: image.mediaType,
            })),
          ],
        };
      case "assistant": {
        const calls = message.toolCalls ?? [];
        if (calls.length === 0) return { role: "assistant", content: message.content };
        return {
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
            ...calls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: names.wire(call.name),
              // A call whose arguments didn't parse (cut off mid-stream) is
              // replayed as {}: providers refuse a whole request whose history
              // holds arguments that aren't a JSON object. Its tool result
              // already tells the model what was wrong.
              input: isObject(call.args) ? call.args : {},
            })),
          ],
        };
      }
      case "tool":
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: names.wire(message.toolName),
              output: { type: "text", value: message.content },
            },
          ],
        };
    }
  });
}
