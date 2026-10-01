import { AppError } from "@ofa/core";
import type { Context } from "hono";
import type { z } from "zod";

/**
 * Parse the JSON body with a contracts schema (the single source of truth for
 * API shapes). Failures become `validation_failed` with per-field messages.
 */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("bad_request", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("validation_failed", "Some fields are invalid", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
