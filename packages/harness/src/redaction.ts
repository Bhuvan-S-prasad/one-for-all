import type { RunContext } from "@ofa/core";

// What the harness writes down passes through the vault's redaction first
// (hard rule 4, M4.11): run events, approval requests and the reply. Tool
// output is already redacted by the executor; this covers what the model
// produced (tool arguments, its answer) and errors thrown along the way.

export type RedactText = (ctx: RunContext, text: string) => Promise<string>;

/** Replace known secret values anywhere inside a JSON-like value. */
export async function redactJson<T>(redact: RedactText, ctx: RunContext, value: T): Promise<T> {
  // One call for the whole value: the vault's redaction handles the escaped
  // forms a secret takes inside JSON, and `[REDACTED]` keeps the JSON valid.
  const text = JSON.stringify(value);
  if (text === undefined) return value;
  const redacted = await redact(ctx, text);
  if (redacted === text) return value;
  try {
    return JSON.parse(redacted) as T;
  } catch {
    return walk(redact, ctx, value);
  }
}

async function walk<T>(redact: RedactText, ctx: RunContext, value: T): Promise<T> {
  if (typeof value === "string") return (await redact(ctx, value)) as T;
  if (Array.isArray(value)) {
    return (await Promise.all(value.map((item) => walk(redact, ctx, item)))) as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, item]) => [await redact(ctx, key), await walk(redact, ctx, item)] as const,
      ),
    );
    return Object.fromEntries(entries) as T;
  }
  return value;
}
