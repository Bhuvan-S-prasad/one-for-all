import { z } from "zod";
import { idSchema } from "./common";

export const emailSchema = z.email().max(254);
export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(128, "Use at most 128 characters");

/** Whether the install still needs its owner account (first run). */
export const setupStatusSchema = z.object({
  needsSetup: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** First-run setup: creates the owner account and the workspace. */
export const firstRunSetupRequestSchema = z.object({
  workspaceName: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  email: emailSchema,
  password: passwordSchema,
});
export type FirstRunSetupRequest = z.infer<typeof firstRunSetupRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionResponseSchema = z.object({
  user: z.object({
    id: idSchema,
    email: emailSchema,
    name: z.string(),
  }),
  workspace: z
    .object({
      id: idSchema,
      name: z.string(),
    })
    .nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
