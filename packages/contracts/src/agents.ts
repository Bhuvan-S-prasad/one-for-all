import { GRANT_MODES, MEMORY_SCOPES, MODEL_TIERS } from "@ofa/core";
import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { familiarLookSchema } from "./familiar";

// An agent is a declarative spec (ARCHITECTURE.md §6.1). Name and standing
// description are columns; everything else in the spec is stored as JSON and
// validated here on the way in and on the way out.

export const modelTierSchema = z.enum(MODEL_TIERS);
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);
export const grantModeSchema = z.enum(GRANT_MODES);

/** How far an agent may go on its own. Policy still has the last word. */
export const AGENT_AUTONOMY = ["suggest", "act-with-approval", "autonomous"] as const;
export const agentAutonomySchema = z.enum(AGENT_AUTONOMY);

/**
 * The tone an agent writes in. It changes wording only, never what the agent
 * may do (M2.26 turns it into a versioned prompt fragment).
 */
export const AGENT_VOICES = ["calm", "cheerful", "brief", "formal"] as const;
export const agentVoiceSchema = z.enum(AGENT_VOICES);

/**
 * A coordinator (a chief of staff) plans and hands work to its team; its own
 * tools that a teammate also has are hidden from it (ADR-0044).
 */
export const AGENT_ROLES = ["specialist", "coordinator"] as const;
export const agentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const AGENT_STATUSES = ["active", "paused", "archived"] as const;
export const agentStatusSchema = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** `@researcher`: lowercase letters, digits and inner hyphens. */
export const agentSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, "Use 1–32 lowercase letters, digits or hyphens");

/** Derive a slug from a display name: "Inbox Assistant" → "inbox-assistant". */
export function toAgentSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug || "agent";
}

/** Per-run limits. Hitting one ends the run with a clear stop reason. */
export const agentBudgetsSchema = z.object({
  steps: z.number().int().min(1).max(200),
  tokens: z.number().int().min(1_000).max(2_000_000),
  /** Optional ceiling in US dollars; free models cost nothing. */
  costUsd: z.number().min(0).max(100).optional(),
});
export type AgentBudgets = z.infer<typeof agentBudgetsSchema>;

export const DEFAULT_AGENT_BUDGETS: AgentBudgets = { steps: 40, tokens: 120_000 };

export const agentSpecSchema = z.object({
  /** One clear job, shown under the name: "Sales outbound". */
  job: z.string().trim().min(1).max(80),
  modelTier: modelTierSchema.default("standard"),
  /** Specialist does its job; coordinator routes work to the team (ADR-0044). */
  role: agentRoleSchema.default("specialist"),
  autonomy: agentAutonomySchema.default("act-with-approval"),
  voice: agentVoiceSchema.default("calm"),
  /** The agent's familiar. */
  avatar: familiarLookSchema,
  memoryScopes: z
    .array(memoryScopeSchema)
    .min(1)
    .max(MEMORY_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, "List each scope once")
    .default(["agent", "workspace"]),
  budgets: agentBudgetsSchema.default(DEFAULT_AGENT_BUDGETS),
});
export type AgentSpec = z.infer<typeof agentSpecSchema>;
/** A spec as sent by a client, before defaults are applied. */
export type AgentSpecInput = z.input<typeof agentSpecSchema>;

/**
 * A tool name (`web.search`, `remember`) or a whole app (`hubspot.*`).
 * Tool names are `app.action` with snake_case after the dot.
 */
export const toolPatternSchema = z
  .string()
  .max(100)
  .regex(
    /^[a-z][a-z0-9_]*(?:\.(?:\*|[a-z][a-z0-9_]*))?$/,
    "Use a tool name like web.search, or app.* for every tool of an app",
  );

export const agentGrantSchema = z.object({
  tool: toolPatternSchema,
  mode: grantModeSchema,
});
export type AgentGrant = z.infer<typeof agentGrantSchema>;

const grantListSchema = z
  .array(agentGrantSchema)
  .max(200)
  .refine(
    (grants) => new Set(grants.map((g) => g.tool)).size === grants.length,
    "List each tool once",
  );

export const agentSchema = z.object({
  id: idSchema,
  slug: agentSlugSchema,
  name: z.string(),
  /** Standing rules, always in context. Task instructions belong in the chat. */
  description: z.string(),
  status: agentStatusSchema,
  spec: agentSpecSchema,
  grants: z.array(agentGrantSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Agent = z.infer<typeof agentSchema>;

const agentNameSchema = z.string().trim().min(1).max(40);
const agentDescriptionSchema = z.string().trim().max(4_000);

/** Hatching an agent. The slug defaults to one derived from the name. */
export const createAgentRequestSchema = z.object({
  name: agentNameSchema,
  slug: agentSlugSchema.optional(),
  description: agentDescriptionSchema.default(""),
  spec: agentSpecSchema,
  grants: grantListSchema.default([]),
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
/** What a client sends, before defaults are applied. */
export type CreateAgentInput = z.input<typeof createAgentRequestSchema>;

/** Every field optional; `spec` and `grants` replace the stored value whole. */
export const updateAgentRequestSchema = z
  .object({
    name: agentNameSchema,
    slug: agentSlugSchema,
    description: agentDescriptionSchema,
    status: agentStatusSchema,
    spec: agentSpecSchema,
    grants: grantListSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Change at least one field");
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

/** What an agent can do in one area, from its grants (ADR-0044). */
export const agentCapabilitySchema = z.object({
  area: z.string().max(100),
  abilities: z.array(z.string().max(200)).max(50),
  /** The tools behind it, so a coordinator's covered tools can be shown. */
  tools: z.array(z.string().max(100)).max(200),
});
export type AgentCapabilityCard = z.infer<typeof agentCapabilitySchema>;

/** The workspace's active agents as a coordinator sees them (TC.07). */
export const teamRosterSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      slug: agentSlugSchema,
      name: z.string(),
      job: z.string(),
      capabilities: z.array(agentCapabilitySchema),
    }),
  ),
});
export type TeamRoster = z.infer<typeof teamRosterSchema>;
