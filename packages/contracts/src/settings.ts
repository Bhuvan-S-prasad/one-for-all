import { z } from "zod";
import { agentSchema, modelTierSchema } from "./agents";
import { idSchema, pageSchema, paginationQuerySchema } from "./common";
import { runEventSchema, runSchema } from "./runs";
import { messageSchema } from "./threads";

// Response envelopes and settings (M2.19).

export const agentListResponseSchema = z.object({ items: z.array(agentSchema) });
export type AgentListResponse = z.infer<typeof agentListResponseSchema>;

export const messagePageSchema = pageSchema(messageSchema);
export type MessagePage = z.infer<typeof messagePageSchema>;

export const runPageSchema = pageSchema(runSchema);
export type RunPage = z.infer<typeof runPageSchema>;

export const runListQuerySchema = paginationQuerySchema.extend({ agentId: idSchema.optional() });
export type RunListQuery = z.infer<typeof runListQuerySchema>;

export const runEventListSchema = z.object({ items: z.array(runEventSchema) });
export type RunEventList = z.infer<typeof runEventListSchema>;

/** The model provider and whether this workspace can reach it. Never the key itself. */
export const llmSettingsSchema = z.object({
  provider: z.object({ id: z.string(), label: z.string(), requiresApiKey: z.boolean() }),
  key: z.object({
    configured: z.boolean(),
    /** `workspace`: saved in Settings. `environment`: LLM_API_KEY on the server. */
    source: z.enum(["workspace", "environment"]).nullable(),
    /** Last four characters, when known. */
    hint: z.string().nullable(),
  }),
  /** Model IDs per tier, best first. */
  tiers: z.record(modelTierSchema, z.array(z.string())),
});
export type LlmSettings = z.infer<typeof llmSettingsSchema>;

export const setLlmKeyRequestSchema = z.object({
  apiKey: z.string().trim().min(8, "That key looks too short").max(500),
});
export type SetLlmKeyRequest = z.infer<typeof setLlmKeyRequestSchema>;
