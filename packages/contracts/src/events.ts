import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { runTriggerSchema } from "./runs";

// Durable events sent to Inngest (ADR-0006). Names follow `domain/noun.verb`.
// Payloads carry IDs only; functions load the rest inside their steps.

const tenant = { workspaceId: idSchema, userId: idSchema };

export const INNGEST_EVENTS = {
  /** A person wrote to an agent; starts or steers a run. */
  messageReceived: "agent/message.received",
  /** A person pressed Stop. Cancels the run at its next step boundary. */
  runCancelled: "agent/run.cancelled",
  /** A run answered; the agent may learn from the exchange, off its own turn. */
  runSucceeded: "agent/run.succeeded",
  /** A person answered an approval request; the waiting run carries on. */
  approvalDecided: "approval/decided",
  /** An agent set a task or reminder for later (M5.07); it sleeps until it is due. */
  scheduleCreated: "schedule/item.created",
  /** A person cancelled a task or reminder before it was due. */
  scheduleCancelled: "schedule/item.cancelled",
} as const;

export const messageReceivedEventSchema = z.object({
  ...tenant,
  agentId: idSchema,
  threadId: idSchema,
  messageId: idSchema,
  runId: idSchema,
  trigger: runTriggerSchema,
});
export type MessageReceivedEvent = z.infer<typeof messageReceivedEventSchema>;

export const runCancelledEventSchema = z.object({
  ...tenant,
  runId: idSchema,
  /**
   * `stopped`: a person pressed Stop or wrote "stop" (the default);
   * `preempted`: background work set aside for a person's message (M5.05).
   */
  reason: z.enum(["stopped", "preempted"]).optional(),
});
export type RunCancelledEvent = z.infer<typeof runCancelledEventSchema>;

export const runSucceededEventSchema = z.object({
  ...tenant,
  agentId: idSchema,
  runId: idSchema,
  threadId: idSchema,
  /** The reply: what the run learns from ends here. */
  messageId: idSchema,
});
export type RunSucceededEvent = z.infer<typeof runSucceededEventSchema>;

export const approvalDecidedEventSchema = z.object({
  ...tenant,
  approvalId: idSchema,
  runId: idSchema,
  decision: z.enum(["approved", "rejected"]),
});
export type ApprovalDecidedEvent = z.infer<typeof approvalDecidedEventSchema>;

export const scheduleCreatedEventSchema = z.object({
  ...tenant,
  scheduleId: idSchema,
  /** When it is due. */
  dueAt: timestampSchema,
});
export type ScheduleCreatedEvent = z.infer<typeof scheduleCreatedEventSchema>;

export const scheduleCancelledEventSchema = z.object({ ...tenant, scheduleId: idSchema });
export type ScheduleCancelledEvent = z.infer<typeof scheduleCancelledEventSchema>;
