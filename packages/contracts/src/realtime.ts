import { z } from "zod";
import { agentSchema } from "./agents";
import { runEventSchema, runSchema } from "./runs";
import { messageSchema } from "./threads";

// Live updates over the WebSocket at `/api/ws`. A connection receives
// everything that happens in its workspace; clients pick what they show.
// Server-to-client only: the socket carries no commands, so every action
// still goes through the REST API and its checks.

export const realtimeMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("run.event"), event: runEventSchema }),
  z.object({ type: z.literal("run.updated"), run: runSchema }),
  z.object({ type: z.literal("message.created"), message: messageSchema }),
  z.object({ type: z.literal("agent.updated"), agent: agentSchema }),
]);
export type RealtimeMessage = z.infer<typeof realtimeMessageSchema>;
