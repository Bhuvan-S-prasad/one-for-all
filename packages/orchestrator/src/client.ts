import {
  INNGEST_EVENTS,
  messageReceivedEventSchema,
  runCancelledEventSchema,
  type MessageReceivedEvent,
  type RunCancelledEvent,
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
  };
}
