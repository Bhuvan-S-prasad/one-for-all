import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  mode: z.enum(["self-host", "cloud"]),
  checks: z.object({
    database: z.enum(["ok", "error"]),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
