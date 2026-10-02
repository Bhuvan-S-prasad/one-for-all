import type {
  MemoryScope,
  RunContext,
  ToolAnnotations,
  ToolDescriptor,
  ToolSourceKind,
} from "@ofa/core";
import { z } from "zod";

// The tool definition interface (M2.13). A tool declares its schema and risk;
// it never checks permissions itself. The executor does that before `run`
// is called (hard rule 5).

export interface ToolRunContext extends RunContext {
  /** `runId:step`: pass it to APIs that accept idempotency keys (ADR-0015). */
  readonly idempotencyKey: string;
  /** The run has read untrusted content; memory written now is unverified. */
  readonly tainted: boolean;
  readonly memoryScopes: readonly MemoryScope[];
}

export interface ToolRunResult {
  /** Text or JSON for the model. Objects are serialised as JSON. */
  readonly content: string | Record<string, unknown> | unknown[];
  /** True when the content came from outside the system (web pages, email, API data). */
  readonly untrusted: boolean;
}

export interface ToolDefinition<Input = unknown> {
  /** `app.action`, snake_case after the dot. */
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<Input>;
  readonly annotations: ToolAnnotations;
  readonly source?: ToolSourceKind;
  run(args: Input, ctx: ToolRunContext): Promise<ToolRunResult>;
  /**
   * For tools with side effects that are not idempotent: after a crash left
   * the call `in_flight`, check whether it already happened (e.g. look in the
   * Sent folder). Return the result if it did, null if it did not (ADR-0015).
   */
  verify?(args: Input, ctx: ToolRunContext): Promise<ToolRunResult | null>;
}

/** Keeps the input type flowing from the schema into `run`. */
export function defineTool<Input>(tool: ToolDefinition<Input>): ToolDefinition<Input> {
  return tool;
}

export function toDescriptor(tool: ToolDefinition<never>): ToolDescriptor {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input as z.ZodType, {
    target: "draft-7",
  }) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
    annotations: tool.annotations,
    source: tool.source ?? "builtin",
  };
}

export interface ToolRegistry {
  get(name: string): ToolDefinition<unknown> | undefined;
  descriptors(): readonly ToolDescriptor[];
}

export function createToolRegistry(tools: readonly ToolDefinition<never>[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition<unknown>>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    byName.set(tool.name, tool as unknown as ToolDefinition<unknown>);
  }
  const descriptors = tools.map(toDescriptor);
  return {
    get: (name) => byName.get(name),
    descriptors: () => descriptors,
  };
}
