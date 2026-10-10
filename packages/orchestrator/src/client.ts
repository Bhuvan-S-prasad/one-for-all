import {
  approvalDecidedEventSchema,
  INNGEST_EVENTS,
  messageReceivedEventSchema,
  runCancelledEventSchema,
  memoryConsolidationRequestedEventSchema,
  scheduleCancelledEventSchema,
  scheduleCreatedEventSchema,
  type ApprovalDecidedEvent,
  type MemoryConsolidationRequestedEvent,
  type MessageReceivedEvent,
  type RunCancelledEvent,
  type ScheduleCancelledEvent,
  type ScheduleCreatedEvent,
} from "@ofa/contracts";
import { Inngest } from "inngest";

export interface InngestClientOptions {
  /** Local dev server: no keys, no signatures. */
  readonly isDev: boolean;
  readonly baseUrl?: string;
  readonly eventKey?: string;
}

export function createInngestClient(options: InngestClientOptions): Inngest {
  return new Inngest({
    id: "one-for-all",
    isDev: options.isDev,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.eventKey ? { eventKey: options.eventKey } : {}),
  });
}

/** How the API starts and stops runs. Payloads are validated before they leave. */
export interface RunDispatcher {
  messageReceived(event: MessageReceivedEvent): Promise<void>;
  cancelRun(event: RunCancelledEvent): Promise<void>;
  /** Wake a run waiting on this approval. */
  approvalDecided(event: ApprovalDecidedEvent): Promise<void>;
  /** Start the wait of a task or reminder set for later (M5.07). */
  scheduleCreated(event: ScheduleCreatedEvent): Promise<void>;
  /** End that wait early: the item was cancelled. */
  scheduleCancelled(event: ScheduleCancelledEvent): Promise<void>;
  /** Consolidate a workspace's memory now (M5.09). */
  consolidateMemory(event: MemoryConsolidationRequestedEvent): Promise<void>;
}

export function createRunDispatcher(inngest: Inngest): RunDispatcher {
  return {
    async messageReceived(event) {
      await inngest.send({
        name: INNGEST_EVENTS.messageReceived,
        data: messageReceivedEventSchema.parse(event),
        // Inngest drops a second send with the same ID: a retried request starts one run.
        id: `message-received-${event.runId}`,
      });
    },
    async cancelRun(event) {
      await inngest.send({
        name: INNGEST_EVENTS.runCancelled,
        data: runCancelledEventSchema.parse(event),
        id: `run-cancelled-${event.runId}`,
      });
    },
    async approvalDecided(event) {
      await inngest.send({
        name: INNGEST_EVENTS.approvalDecided,
        data: approvalDecidedEventSchema.parse(event),
        id: `approval-decided-${event.approvalId}`,
      });
    },
    async scheduleCreated(event) {
      await inngest.send({
        name: INNGEST_EVENTS.scheduleCreated,
        data: scheduleCreatedEventSchema.parse(event),
        id: `schedule-created-${event.scheduleId}`,
      });
    },
    async scheduleCancelled(event) {
      await inngest.send({
        name: INNGEST_EVENTS.scheduleCancelled,
        data: scheduleCancelledEventSchema.parse(event),
        id: `schedule-cancelled-${event.scheduleId}`,
      });
    },
    async consolidateMemory(event) {
      await inngest.send({
        name: INNGEST_EVENTS.memoryConsolidationRequested,
        data: memoryConsolidationRequestedEventSchema.parse(event),
      });
    },
  };
}
