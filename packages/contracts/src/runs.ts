import { MEMORY_SCOPES, MODEL_ERROR_CODES, VERDICTS } from "@ofa/core";
import { z } from "zod";
import { modelTierSchema } from "./agents";
import { idSchema, timestampSchema } from "./common";

// A run is one execution of an agent, and its events are the record of what
// happened (ADR-0014). The Activity view, traces, evals and audit all read
// these events, so their shapes are fixed here.

/**
 * `routine`: on a routine's schedule; `manual`: a routine's test run (M5.06);
 * `schedule`: a task an agent set for later (M5.07).
 */
export const RUN_TRIGGERS = [
  "message",
  "routine",
  "delegation",
  "event",
  "manual",
  "schedule",
] as const;
export const runTriggerSchema = z.enum(RUN_TRIGGERS);

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Why the loop stopped (ARCHITECTURE.md §6.2). */
export const RUN_STOP_REASONS = [
  "final_answer",
  "needs_human",
  "step_budget",
  "token_budget",
  "cost_budget",
  "loop_detected",
  "user_stopped",
  "error",
  /** A person's follow-up was answered by the run already working in that chat (M5.05). */
  "steered",
  /** Background work set aside because a person wrote to the agent (M5.05). */
  "preempted",
] as const;
export const runStopReasonSchema = z.enum(RUN_STOP_REASONS);
export type RunStopReason = z.infer<typeof runStopReasonSchema>;

const count = z.number().int().min(0);
const usd = z.number().min(0);

export const runUsageSchema = z.object({
  inputTokens: count,
  outputTokens: count,
  costUsd: usd,
  modelCalls: count,
  toolCalls: count,
});
export type RunUsage = z.infer<typeof runUsageSchema>;

export const EMPTY_RUN_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  modelCalls: 0,
  toolCalls: 0,
};

export const runErrorSchema = z.object({
  code: z.string().max(64),
  message: z.string().max(2_000),
});
export type RunError = z.infer<typeof runErrorSchema>;

/** Length of the request and reply previews on a run. */
export const RUN_PREVIEW_CHARS = 280;

export const runSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  threadId: idSchema.nullable(),
  parentRunId: idSchema.nullable(),
  trigger: runTriggerSchema,
  status: runStatusSchema,
  /** The run has read untrusted content; outbound tools now need approval. */
  tainted: z.boolean(),
  usage: runUsageSchema,
  error: runErrorSchema.nullable(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  /**
   * The start of the message that started the run, and of the agent's reply
   * (UX.10). Sent in run lists and single reads; absent from live updates,
   * which keep the values already known.
   */
  request: z.string().max(RUN_PREVIEW_CHARS).nullable().optional(),
  reply: z.string().max(RUN_PREVIEW_CHARS).nullable().optional(),
});
export type Run = z.infer<typeof runSchema>;

// ── Run events ───────────────────────────────────────────────────────────────
// Payloads never contain credentials (hard rule 4): tool arguments and results
// are redacted before they are appended, and results appear only as previews.

/**
 * How a handoff ended, as the delegating agent is told (M5.01): `done` with
 * an answer, `stopped` at a budget, or no answer at all.
 */
export const DELEGATION_STATUSES = ["done", "stopped", "failed", "cancelled"] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

/** Shown in the Activity view; the full output lives in an artifact. */
const preview = z.string().max(500);
const toolName = z.string().max(100);
const modelName = z.string().max(200);

const RUN_EVENT_PAYLOADS = {
  "run.started": z.object({ trigger: runTriggerSchema, tier: modelTierSchema }),
  "run.waiting": z.object({
    reason: z.enum(["approval", "model_capacity", "user_input"]),
    /** When the run expects to continue, if known (e.g. the model quota resets). */
    until: timestampSchema.optional(),
  }),
  "run.resumed": z.object({}),
  /** First untrusted read; the run stays tainted until it ends. */
  "run.tainted": z.object({ source: z.string().max(200) }),
  "run.compacted": z.object({ tokensBefore: count, tokensAfter: count }),
  /** The person wrote again while the run worked; it read their messages at a step boundary (M5.05). */
  "run.steered": z.object({ messageIds: z.array(idSchema).min(1).max(20), preview }),
  /** A proactive check found nothing that needs the person, and posted nothing (M5.10). */
  "check.quiet": z.object({}),
  "run.ended": z.object({
    status: z.enum(["succeeded", "failed", "cancelled"]),
    stopReason: runStopReasonSchema,
    usage: runUsageSchema,
    error: runErrorSchema.optional(),
  }),
  "model.called": z.object({
    provider: z.string().max(50),
    model: modelName,
    tier: modelTierSchema,
    // Every template the call used, joined with "+" (e.g. "platform.rules@3+agent.identity@1+…").
    promptVersion: z.string().max(200).optional(),
    inputTokens: count,
    outputTokens: count,
    costUsd: usd,
    durationMs: count,
    finishReason: z.string().max(32),
    toolCalls: count,
    /** Models tried first that failed, when a fallback served the call. */
    fellBackFrom: z.array(modelName).optional(),
  }),
  "model.failed": z.object({
    provider: z.string().max(50),
    model: modelName,
    tier: modelTierSchema,
    code: z.enum(MODEL_ERROR_CODES),
    message: z.string().max(2_000),
  }),
  "message.created": z.object({ messageId: idSchema, preview }),
  "tool.called": z.object({
    toolCallId: idSchema,
    tool: toolName,
    args: z.unknown(),
    idempotencyKey: z.string().max(200),
  }),
  "policy.decided": z.object({
    toolCallId: idSchema,
    tool: toolName,
    verdict: z.enum(VERDICTS),
    reasons: z.array(z.string().max(500)),
  }),
  "approval.requested": z.object({ approvalId: idSchema, toolCallId: idSchema, tool: toolName }),
  "approval.decided": z.object({
    approvalId: idSchema,
    decision: z.enum(["approved", "edited", "rejected", "expired"]),
    decidedBy: idSchema.nullable(),
    /** Allowed for the rest of the run (M4.07). */
    allowedSite: z.string().max(253).optional(),
    /** `edited`: the arguments the person changed before approving (ADR-0030). */
    edited: z.array(z.string().max(100)).max(50).optional(),
  }),
  "tool.completed": z.object({
    toolCallId: idSchema,
    tool: toolName,
    durationMs: count,
    untrusted: z.boolean(),
    artifactId: idSchema.optional(),
    preview,
  }),
  "tool.failed": z.object({
    toolCallId: idSchema,
    tool: toolName,
    durationMs: count,
    code: z.string().max(64),
    message: z.string().max(2_000),
  }),
  "memory.written": z.object({
    memoryId: idSchema,
    scope: z.enum(MEMORY_SCOPES),
    verified: z.boolean(),
  }),
  /** Work handed to another agent as a child run (M5.01). */
  "delegation.started": z.object({
    toolCallId: idSchema,
    childRunId: idSchema,
    agentId: idSchema,
    agentName: z.string().max(200),
  }),
  "delegation.finished": z.object({
    toolCallId: idSchema,
    childRunId: idSchema,
    status: z.enum(DELEGATION_STATUSES),
    preview,
  }),
} as const;

type Payloads = typeof RUN_EVENT_PAYLOADS;
export type RunEventType = keyof Payloads;
export const RUN_EVENT_TYPES = Object.keys(RUN_EVENT_PAYLOADS) as RunEventType[];

export type RunEventPayload<T extends RunEventType> = z.infer<Payloads[T]>;

function body<T extends RunEventType>(type: T) {
  return z.object({ type: z.literal(type), payload: RUN_EVENT_PAYLOADS[type] });
}

/** What the harness appends: a type and its payload. */
export const runEventInputSchema = z.discriminatedUnion("type", [
  body("run.started"),
  body("run.waiting"),
  body("run.resumed"),
  body("run.tainted"),
  body("run.compacted"),
  body("run.steered"),
  body("check.quiet"),
  body("run.ended"),
  body("model.called"),
  body("model.failed"),
  body("message.created"),
  body("tool.called"),
  body("policy.decided"),
  body("approval.requested"),
  body("approval.decided"),
  body("tool.completed"),
  body("tool.failed"),
  body("memory.written"),
  body("delegation.started"),
  body("delegation.finished"),
]);
export type RunEventInput = z.infer<typeof runEventInputSchema>;

/** A stored event. `seq` orders events within a run, starting at 0. */
export const runEventSchema = z.intersection(
  z.object({
    id: idSchema,
    runId: idSchema,
    seq: count,
    createdAt: timestampSchema,
  }),
  runEventInputSchema,
);
export type RunEvent = z.infer<typeof runEventSchema>;
