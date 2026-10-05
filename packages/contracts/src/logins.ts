import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

// Saved logins (M3.08, ADR-0012): typed into a site's own pages by a tool,
// never shown to agents and never sent back by the API.

const site = z.string().trim().min(3).max(200);

/** What the API says about a saved login: never the password, nor the username. */
export const savedLoginSchema = z.object({
  site: z.string(),
  updatedAt: timestampSchema,
});
export type SavedLogin = z.infer<typeof savedLoginSchema>;

export const savedLoginListSchema = z.object({ items: z.array(savedLoginSchema) });
export type SavedLoginList = z.infer<typeof savedLoginListSchema>;

export const saveLoginRequestSchema = z.object({
  site,
  username: z.string().min(1).max(320),
  // Shorter values can't be hidden from output reliably (ADR-0012).
  password: z.string().min(8, "Passwords under 8 characters can't be saved safely").max(500),
});
export type SaveLoginRequest = z.infer<typeof saveLoginRequestSchema>;

/** Copy one site's browser login from this agent to another (ADR-0010). */
export const shareLoginRequestSchema = z.object({
  to: idSchema,
  site,
});
export type ShareLoginRequest = z.infer<typeof shareLoginRequestSchema>;

export const shareLoginResponseSchema = z.object({ cookies: z.number().int().min(0) });
export type ShareLoginResponse = z.infer<typeof shareLoginResponseSchema>;
