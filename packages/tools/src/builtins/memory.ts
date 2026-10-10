import { MEMORY_SCOPES, type MemoryScope, type MemoryStore } from "@ofa/core";
import { z } from "zod";
import { defineTool } from "../define";

// remember / recall (ARCHITECTURE.md §8). Writes go through the executor and
// policy like any tool. A fact written during a tainted run is unverified: it
// is kept, but not preloaded until a person confirms it.

/** The requested scope if this agent may use it, otherwise its default. */
function allowedScope(
  requested: MemoryScope | undefined,
  allowed: readonly MemoryScope[],
): MemoryScope {
  if (requested && allowed.includes(requested)) return requested;
  if (allowed.includes("agent")) return "agent";
  const first = allowed[0];
  if (!first) throw Object.assign(new Error("This agent has no memory"), { code: "no_memory" });
  return first;
}

export function rememberTool(memory: MemoryStore) {
  return defineTool({
    name: "remember",
    description:
      "Save a durable fact or preference for future conversations, e.g. 'Sam prefers summaries under 100 words'. Not for temporary notes.",
    input: z.object({
      fact: z.string().trim().min(8).max(500),
      kind: z.enum(["fact", "preference"]).default("fact"),
      scope: z
        .enum(MEMORY_SCOPES)
        .optional()
        .describe(
          "agent: your own notes (default) · workspace: shared with every agent · agent_user: about this person",
        ),
    }),
    annotations: {},
    async run({ fact, kind, scope }, ctx) {
      const used = allowedScope(scope, ctx.memoryScopes);
      const record = await memory.write(ctx, {
        scope: used,
        kind,
        content: fact,
        verified: !ctx.tainted,
      });
      const where =
        scope && scope !== used ? ` (in ${used} memory: you can't use ${scope} memory)` : "";
      return {
        content: record.verified
          ? `Remembered${where}.`
          : "Saved as unverified: it was learned after reading outside content, so a person must confirm it before it is used.",
        untrusted: false,
      };
    },
  });
}

export function recallTool(memory: MemoryStore) {
  return defineTool({
    name: "recall",
    description: "Search your memory for facts and preferences saved earlier.",
    input: z.object({
      query: z.string().trim().min(2).max(300),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    annotations: { readOnly: true, idempotent: true },
    async run({ query, limit }, ctx) {
      if (ctx.memoryScopes.length === 0)
        return { content: "This agent has no memory.", untrusted: false };
      const found = await memory.recall(ctx, { query, scopes: ctx.memoryScopes, limit });
      return {
        content: found.length
          ? found.map((m) => ({
              fact: m.content,
              scope: m.scope,
              saved: m.createdAt.toISOString().slice(0, 10),
            }))
          : "Nothing found.",
        untrusted: false,
      };
    },
  });
}

export function todoTool() {
  return defineTool({
    name: "todo.write",
    description:
      "Write your plan for a multi-step task as a checklist. Send the whole list each time, marking finished items done.",
    input: z.object({
      items: z
        .array(
          z.object({ text: z.string().trim().min(1).max(200), done: z.boolean().default(false) }),
        )
        .min(1)
        .max(20),
    }),
    annotations: { readOnly: true, idempotent: true },
    async run({ items }) {
      const left = items.filter((i) => !i.done).length;
      return { content: `Plan saved: ${items.length} items, ${left} left.`, untrusted: false };
    },
  });
}
