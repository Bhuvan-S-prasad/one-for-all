import type { ToolRunContext } from "@ofa/tools";
import { defineTool, type ToolDefinition } from "@ofa/tools";
import { z } from "zod";
import type { McpConnections } from "../connections";

// Google's Gmail MCP server reads mail and writes drafts but cannot send
// (ADR-0029). This one tool sends a draft the agent wrote, through the
// Gmail API with the same sign-in. Sending a draft, not composing a message,
// keeps what a person reviews and what goes out the same, and we never build
// raw email ourselves.

const draftId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "a Gmail draft ID, as gmail.create_draft returns it");

interface DraftMetadata {
  message?: {
    snippet?: string;
    payload?: { headers?: { name?: string; value?: string }[] };
  };
}

function header(draft: DraftMetadata, name: string): string {
  const found = draft.message?.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return (found?.value ?? "").replace(/\s+/g, " ").trim();
}

async function failure(res: Response, what: string): Promise<Error> {
  const text = (await res.text().catch(() => "")).slice(0, 500);
  return Object.assign(new Error(`Gmail couldn't ${what} (HTTP ${res.status}). ${text}`.trim()), {
    code: res.status === 404 ? "not_found" : "app_error",
  });
}

/** `gmail.send_draft` for one installed Gmail server; `api` is the Gmail API's origin. */
export function gmailTools(
  serverId: string,
  mcp: McpConnections,
  api: string,
): readonly ToolDefinition<unknown>[] {
  const drafts = `${api}/gmail/v1/users/me/drafts`;
  const getDraft = (ctx: ToolRunContext, id: string) =>
    mcp.fetchAs(
      ctx,
      serverId,
      `${drafts}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject`,
    );

  const sendDraft = defineTool({
    name: "gmail.send_draft",
    description:
      "Send one of the person's Gmail drafts, exactly as it is, by its draft ID (from gmail.create_draft). The person approves before it goes.",
    input: z.object({ draft_id: draftId }),
    annotations: { outbound: true },
    source: "mcp",
    async run({ draft_id }, ctx) {
      const res = await mcp.fetchAs(ctx, serverId, `${drafts}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draft_id }),
      });
      if (!res.ok) throw await failure(res, "send that draft");
      const sent = (await res.json()) as { id?: string; threadId?: string };
      return {
        content: `Sent. Gmail message ${sent.id ?? "?"} in thread ${sent.threadId ?? "?"}.`,
        untrusted: false,
      };
    },
    /** Sending is not idempotent: after a crash, a draft that is gone was sent. */
    async verify({ draft_id }, ctx) {
      const res = await getDraft(ctx, draft_id);
      if (res.status === 404) {
        return { content: "Sent (the draft is gone from Gmail).", untrusted: false };
      }
      return null;
    },
    /** The approval card says what goes out and to whom, read from the draft itself. */
    async describe({ draft_id }, ctx) {
      const res = await getDraft(ctx, draft_id);
      if (!res.ok) return `Send Gmail draft ${draft_id}`;
      const draft = (await res.json()) as DraftMetadata;
      const to = header(draft, "To") || "(no recipient)";
      const cc = [header(draft, "Cc"), header(draft, "Bcc")].filter(Boolean).join(", ");
      const subject = header(draft, "Subject") || "(no subject)";
      const snippet = draft.message?.snippet?.trim();
      return `Send the email “${subject}” to ${to}${cc ? `, copying ${cc}` : ""}${snippet ? `\n${snippet}` : ""}`;
    },
  });

  return [sendDraft as unknown as ToolDefinition<unknown>];
}
