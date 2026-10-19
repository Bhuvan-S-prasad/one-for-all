import { z } from "zod";
import { defineTool } from "../define";

// Waiting for a long job (EN.12): a video an app is making, a render on the
// computer. The agent asks for a pause; the harness sleeps durably (Inngest
// `step.sleep`), holding no process and spending no model calls, then the
// agent checks the job again. A platform tool: every agent may wait.

export const WAIT_TOOL = "wait";
export const MAX_WAIT_SECONDS = 600;

export function waitTool() {
  return defineTool({
    name: WAIT_TOOL,
    description:
      "Pause before checking on something that takes a while, such as a video an app is still making or a long render on your computer. Give the seconds to wait (5 to 600); then check its status again. Don't wait for things that are already done.",
    input: z.object({
      seconds: z.number().int().min(5).max(MAX_WAIT_SECONDS),
      reason: z.string().max(200).optional().describe("What you are waiting for"),
    }),
    annotations: { readOnly: true, idempotent: true },
    async describe({ seconds, reason }) {
      return `Wait ${seconds} s${reason ? ` for ${reason}` : ""}`;
    },
    async run({ seconds }) {
      // The pause itself is the harness's (a durable sleep after this call).
      return { content: `Waited ${seconds} s. Check on it now.`, untrusted: false };
    },
  });
}
