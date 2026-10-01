import type { AgentId, ThreadId } from "../ids";
import type { TenantContext } from "../tenant";

export type ChannelKind = "web" | "mobile" | "telegram" | "slack" | "email";

export interface InboundMessage {
  readonly channel: ChannelKind;
  /** The sender's identity on the channel (e.g. Telegram chat ID). */
  readonly externalSenderId: string;
  readonly threadId?: ThreadId;
  readonly agentId?: AgentId;
  readonly text: string;
  readonly receivedAt: Date;
}

export type OutboundMessage =
  | { readonly kind: "text"; readonly threadId: ThreadId; readonly text: string }
  | {
      readonly kind: "approval_request";
      readonly threadId: ThreadId;
      readonly approvalId: string;
      readonly summary: string;
    };

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(ctx: TenantContext, message: OutboundMessage): Promise<void>;
}
