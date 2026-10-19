import { z } from "zod";
import { agentSchema, modelTierSchema } from "./agents";
import { idSchema, pageSchema, paginationQuerySchema, timestampSchema } from "./common";
import { RUN_STATUSES, runEventSchema, runSchema, runStatusSchema } from "./runs";
import { timeZoneSchema } from "./routines";
import { messageSchema, threadSummarySchema } from "./threads";

// Response envelopes and settings (M2.19).

export const agentListResponseSchema = z.object({ items: z.array(agentSchema) });
export type AgentListResponse = z.infer<typeof agentListResponseSchema>;

export const messagePageSchema = pageSchema(messageSchema);
export type MessagePage = z.infer<typeof messagePageSchema>;

export const runPageSchema = pageSchema(runSchema);
export type RunPage = z.infer<typeof runPageSchema>;

/** Activity filters (UX.10): `status=running,failed` and a search over what was asked. */
export const runListQuerySchema = paginationQuerySchema.extend({
  agentId: idSchema.optional(),
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",").filter(Boolean) : undefined))
    .pipe(z.array(runStatusSchema).max(RUN_STATUSES.length).optional()),
  q: z.string().trim().min(1).max(200).optional(),
});
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

/** Model requests used today against the provider's daily free quota (UX.11). */
export const usageTodaySchema = z.object({
  /** Start of the quota day (UTC midnight, when free quotas reset). */
  since: timestampSchema,
  resetsAt: timestampSchema,
  /** Model calls today that count against the daily limit (all calls when there is none). */
  requests: z.number().int().min(0),
  /** The provider's daily limit for the models in use; null when none applies. */
  dailyLimit: z.number().int().positive().nullable(),
  perMinute: z.number().int().positive().nullable(),
});
export type UsageToday = z.infer<typeof usageTodaySchema>;

/**
 * Paid app credits this month (EN.15, ADR-0048): estimates from the catalog,
 * against the workspace's monthly cap, per agent for Activity.
 */
export const spendSummarySchema = z.object({
  /** Start of the month counted (UTC). */
  since: timestampSchema,
  spentUsd: z.number().min(0),
  /** Most the workspace allows a month; null: no limit. */
  capUsd: z.number().min(0).nullable(),
  byAgent: z.array(
    z.object({
      agentId: idSchema,
      /** Null when the agent has since been removed. */
      name: z.string().nullable(),
      calls: z.number().int().min(0),
      spentUsd: z.number().min(0),
    }),
  ),
});
export type SpendSummary = z.infer<typeof spendSummarySchema>;

export const setSpendCapRequestSchema = z.object({
  capUsd: z.number().min(0).max(100_000).nullable(),
});
export type SetSpendCapRequest = z.infer<typeof setSpendCapRequestSchema>;

/** Per agent, for the Agents page (UX.12). */
export const agentStatsSchema = z.object({
  agentId: idSchema,
  runsThisWeek: z.number().int().min(0),
  /** The latest run that finished well, with its request and reply previews. */
  lastResult: runSchema.nullable(),
});
export type AgentStats = z.infer<typeof agentStatsSchema>;

export const agentStatsListSchema = z.object({ items: z.array(agentStatsSchema) });
export type AgentStatsList = z.infer<typeof agentStatsListSchema>;

export const threadListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
});
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

export const threadSummaryPageSchema = pageSchema(threadSummarySchema);
export type ThreadSummaryPage = z.infer<typeof threadSummaryPageSchema>;

/** Workspace-wide settings (M5.06): the time zone routines and reminders use by default. */
export const workspaceSettingsSchema = z.object({ timeZone: z.string() });
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const updateWorkspaceSettingsRequestSchema = z.object({ timeZone: timeZoneSchema });
export type UpdateWorkspaceSettingsRequest = z.infer<typeof updateWorkspaceSettingsRequestSchema>;
