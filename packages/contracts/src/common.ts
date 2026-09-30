import { ERROR_CODES } from "@ofa/core";
import { z } from "zod";

/** Every error response from the API has this shape. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Cursor pagination for list endpoints. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Wraps an item schema in a page envelope. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const idSchema = z.string().min(1).max(64);
export const timestampSchema = z.iso.datetime({ offset: true });
