import type { BusEvent, WorkspaceId } from "@ofa/core";
import { z } from "zod";

// What travels on the bus (ADR-0007): IDs only, so a payload stays far below
// Postgres's 8 KB NOTIFY limit. Subscribers load the rows they need. Every
// event goes to its workspace's topic, so the realtime gateway subscribes
// once per workspace and never sees another tenant's traffic.

export const busPayloadSchema = z.discriminatedUnion("kind", [
  /** A run event was appended. */
  z.object({ kind: z.literal("run.event"), runId: z.string(), seq: z.number().int() }),
  /** A run's status, usage or taint changed. */
  z.object({ kind: z.literal("run.updated"), runId: z.string() }),
  z.object({ kind: z.literal("message.created"), threadId: z.string(), messageId: z.string() }),
  z.object({ kind: z.literal("agent.updated"), agentId: z.string() }),
]);
export type BusPayload = z.infer<typeof busPayloadSchema>;

export function workspaceTopic(workspaceId: WorkspaceId | string): string {
  return `workspace:${workspaceId}`;
}

export function workspaceEvent(
  workspaceId: WorkspaceId | string,
  payload: BusPayload,
): BusEvent<BusPayload> {
  return { topic: workspaceTopic(workspaceId), payload };
}
