import { APPROVAL_SCOPES, APPROVAL_STATUSES, VERDICTS } from "@ofa/core";
import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

// Approvals (ARCHITECTURE.md §6.2): a run paused until a person agrees to
// one tool call. The card shows what the call would do and why it waits.

export const approvalSchema = z.object({
  id: idSchema,
  runId: idSchema,
  agentId: idSchema,
  /** The chat the run belongs to, for links from the Approvals page. */
  threadId: idSchema.nullable(),
  toolCallId: idSchema,
  tool: z.string(),
  args: z.unknown(),
  /** What the call would do, in plain words. */
  summary: z.string(),
  reasons: z.array(z.string()),
  verdict: z.enum(VERDICTS),
  /** The site the person may allow for the rest of the run; null when only a one-off answer fits. */
  site: z.string().nullable(),
  scope: z.enum(APPROVAL_SCOPES),
  /** Top-level text arguments the person may change before approving (ADR-0030). */
  editable: z.array(z.string()),
  /** List the arguments on the card: the summary doesn't say them. */
  showArgs: z.boolean(),
  /** What the person changed, by argument; the call ran with these. */
  edits: z.record(z.string(), z.string()).nullable(),
  status: z.enum(APPROVAL_STATUSES),
  decidedBy: idSchema.nullable(),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema,
});
export type Approval = z.infer<typeof approvalSchema>;

export const approvalListSchema = z.object({ items: z.array(approvalSchema) });
export type ApprovalList = z.infer<typeof approvalListSchema>;

export const approvalListQuerySchema = z.object({
  agentId: idSchema.optional(),
  runId: idSchema.optional(),
});

export const decideApprovalRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  /** `site`: approve every call like it on the approval’s site for the rest of the run. */
  scope: z.enum(APPROVAL_SCOPES).default("once"),
  /** Changed text arguments, by name (only when approving, only editable ones). */
  edits: z.record(z.string().max(100), z.string().max(50_000)).optional(),
});
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;
