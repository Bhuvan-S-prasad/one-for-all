import { POLICY_RULE_EFFECTS } from "@ofa/core";
import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

// Ask-first and allow-auto rules (ARCHITECTURE.md §10.2). Workspace rules come
// from owners and admins; anyone can add their own, which only ask first.

/** `*`, a tool (`remember`, `gmail.send`) or an app (`gmail.*`); the database checks the same. */
export const ruleToolPattern = z
  .string()
  .regex(
    /^(\*|[a-z][a-z0-9_]*(\.(\*|[a-z0-9_]+))?)$/,
    "Use *, a tool name such as gmail.send, or an app such as gmail.*",
  );

export const policyRuleSchema = z.object({
  id: idSchema,
  tool: z.string(),
  effect: z.enum(POLICY_RULE_EFFECTS),
  scope: z.enum(["workspace", "personal"]),
  agentId: idSchema.nullable(),
  description: z.string(),
  enabled: z.boolean(),
  createdAt: timestampSchema,
});
export type PolicyRuleItem = z.infer<typeof policyRuleSchema>;

export const policyRuleListSchema = z.object({ items: z.array(policyRuleSchema) });
export type PolicyRuleList = z.infer<typeof policyRuleListSchema>;

export const createPolicyRuleSchema = z
  .object({
    tool: ruleToolPattern,
    effect: z.enum(POLICY_RULE_EFFECTS),
    scope: z.enum(["workspace", "personal"]).default("workspace"),
    agentId: idSchema.nullable().default(null),
    description: z.string().trim().max(500).default(""),
  })
  .refine((rule) => rule.scope === "workspace" || rule.effect === "ask_first", {
    message: "Your own rules can only ask first",
    path: ["effect"],
  });
export type CreatePolicyRuleInput = z.input<typeof createPolicyRuleSchema>;

export const updatePolicyRuleSchema = z.object({ enabled: z.boolean() });
