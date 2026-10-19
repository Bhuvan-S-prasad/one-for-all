import { createInterface } from "node:readline";
import { z } from "zod";
import type { VideoEngine } from "./engine";
import type { Runner } from "./runner";
import type { VideoTool } from "./tools";

// The engine as an MCP server over stdio (ADR-0049): for Claude Code, Cursor
// or any MCP client, outside One-for-All. JSON-RPC 2.0, one message per line;
// just enough of the spec to list and call tools, with no dependency.

const PROTOCOL = "2025-06-18";

interface Message {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export interface McpServerOptions {
  readonly engine: VideoEngine;
  readonly tools: readonly VideoTool[];
  readonly runner: Runner;
  readonly name?: string;
  readonly version?: string;
}

/** Answer one message; null for notifications. */
export async function handleMcpMessage(
  message: Message,
  options: McpServerOptions,
): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id ?? null, result });
  const fail = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code, message: text },
  });
  if (message.id === undefined) return null;
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === "string" ? asked : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: options.name ?? "ofa-video", version: options.version ?? "0.1.0" },
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input, { target: "draft-2020-12", io: "input" }),
          annotations: { readOnlyHint: t.readOnly, destructiveHint: false },
        })),
      });
    case "tools/call": {
      const name = message.params?.name;
      const tool = options.tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `No tool called ${String(name)}`);
      const parsed = tool.input.safeParse(message.params?.arguments ?? {});
      if (!parsed.success) {
        return reply({ content: [{ type: "text", text: parsed.error.message }], isError: true });
      }
      try {
        const result = await tool.run(options.engine, parsed.data);
        const content: Record<string, unknown>[] = [{ type: "text", text: result.text }];
        if (result.image) {
          const bytes = await options.runner.readFile(result.image);
          content.push({
            type: "image",
            mimeType: "image/jpeg",
            data: Buffer.from(bytes).toString("base64"),
          });
        }
        return reply({ content, isError: false });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(-32601, `Unknown method ${String(message.method)}`);
  }
}

/** Serve on stdin and stdout until stdin closes. */
export async function serveMcp(options: McpServerOptions): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      continue;
    }
    const answer = await handleMcpMessage(message, options);
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  }
}
