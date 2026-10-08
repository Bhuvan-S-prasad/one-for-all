import { defineTool, htmlToText, type ToolDefinition, type ToolRunContext } from "@ofa/tools";
import { z } from "zod";
import type { McpConnections } from "../connections";
import { MESSAGE_ID, MimeError, parseRecipients, rawEmail } from "./mime";

// Gmail through Google's own API (ADR-0031): Google's Gmail MCP server needs
// a Workspace account in a preview program, so these tools use the Gmail API
// with the person's Google sign-in. Reading is outside content; writing waits
// for a person by default, and the card shows exactly what goes out, with the
// subject and message editable (ADR-0030).

const id = (what: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/, `a Gmail ${what} ID`);

interface Header {
  name?: string;
  value?: string;
}
interface Part {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number };
  parts?: Part[];
}
interface Message {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: Part;
}
interface DraftMetadata {
  message?: Message;
}

function header(part: Part | undefined, name: string): string {
  const found = part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return (found?.value ?? "").replace(/\s+/g, " ").trim();
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** The message's text: its plain part, or its HTML part as text. */
export function messageText(payload: Part | undefined): string {
  const all: Part[] = [];
  const walk = (part: Part | undefined) => {
    if (!part) return;
    all.push(part);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const plain = all.find((p) => p.mimeType === "text/plain" && p.body?.data && !p.filename);
  if (plain) return decode(plain.body!.data!);
  const html = all.find((p) => p.mimeType === "text/html" && p.body?.data && !p.filename);
  return html ? htmlToText(decode(html.body!.data!)) : "";
}

function attachments(payload: Part | undefined): string[] {
  const names: string[] = [];
  const walk = (part: Part | undefined) => {
    if (!part) return;
    if (part.filename) names.push(part.filename);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return names;
}

/**
 * Invisible padding: newsletters fill the inbox preview with these, often
 * hundreds at a time, and each one costs the model a token.
 */
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0xad, 0xad], // soft hyphen
  [0x34f, 0x34f], // combining grapheme joiner
  [0x61c, 0x61c],
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f], // zero-width spaces and joiners, direction marks
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
];

const dropInvisible = (text: string) =>
  Array.from(text)
    .filter((c) => {
      const code = c.codePointAt(0)!;
      return !INVISIBLE.some(([low, high]) => code >= low && code <= high);
    })
    .join("");

/** Links this long are tracking addresses: a few hundred characters that say nothing. */
const LONG_LINK = /\bhttps?:\/\/[^\s<>()[\]"']{60,}/g;

/**
 * Text a model can read cheaply: no invisible padding, no runs of blank lines,
 * and (unless asked for) long links cut to their site. Returns how many links
 * were cut, so the tool can say so.
 */
export function readableText(text: string, fullLinks = false): { text: string; cut: number } {
  let cut = 0;
  let out = dropInvisible(text.replace(/\r\n?/g, "\n"));
  if (!fullLinks) {
    out = out.replace(LONG_LINK, (link) => {
      try {
        const { origin } = new URL(link);
        cut += 1;
        return `${origin}/…`;
      } catch {
        return link;
      }
    });
  }
  out = out
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, cut };
}

/** Characters of an email per read; the agent reads on with `from`, as with web.read_url. */
export const MAIL_CHUNK_CHARS = 4_000;

async function failure(res: Response, what: string, notFound?: string): Promise<Error> {
  const text = (await res.text().catch(() => "")).slice(0, 500);
  // A mistyped ID is the usual cause: say so plainly, so the model fixes the
  // ID instead of reading Google's error. Gmail answers a malformed one with 400.
  if (notFound && (res.status === 404 || (res.status === 400 && /invalid id/i.test(text)))) {
    return Object.assign(new Error(notFound), { code: "not_found" });
  }
  return Object.assign(new Error(`Gmail couldn't ${what} (HTTP ${res.status}). ${text}`.trim()), {
    code: res.status === 404 ? "not_found" : "app_error",
  });
}

const noMessage = (messageId: string) =>
  `No message with ID ${messageId}. Copy the ID exactly as gmail.search_messages shows it, or search again.`;

/** Recipients the model wrote, checked before the call reaches policy or a person. */
const recipients = (field: string) =>
  z
    .string()
    .max(2_000)
    .superRefine((value, ctx) => {
      try {
        if (parseRecipients(field, value).length === 0 && field === "To") {
          ctx.addIssue({ code: "custom", message: "needs at least one address" });
        }
      } catch (error) {
        if (!(error instanceof MimeError)) throw error;
        ctx.addIssue({ code: "custom", message: error.message });
      }
    });

const compose = z.object({
  to: recipients("To").describe("Comma-separated addresses, e.g. sam@example.com"),
  cc: recipients("Cc").optional(),
  subject: z
    .string()
    .max(500)
    .refine((s) => !/[\r\n]/.test(s), "one line"),
  body: z.string().min(1).max(50_000).describe("The message, as plain text"),
  reply_to_message_id: id("message")
    .optional()
    .describe("To reply in a thread: the ID of the message you are answering"),
});
type Compose = z.infer<typeof compose>;

/** Gmail's tools for one installed Gmail app; `origin` is the Gmail API's. */
export function gmailTools(
  serverId: string,
  mcp: McpConnections,
  origin: string,
): readonly ToolDefinition<unknown>[] {
  const api = `${origin}/gmail/v1/users/me`;
  const request = async <T>(
    ctx: ToolRunContext,
    path: string,
    what: string,
    init?: RequestInit,
    notFound?: string,
  ): Promise<T> => {
    const res = await mcp.fetchAs(ctx, serverId, `${api}${path}`, init);
    if (!res.ok) throw await failure(res, what, notFound);
    return (await res.json()) as T;
  };
  const post = <T>(ctx: ToolRunContext, path: string, what: string, body: unknown) =>
    request<T>(ctx, path, what, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const metadata = (names: readonly string[]) =>
    `format=metadata${names.map((n) => `&metadataHeaders=${n}`).join("")}`;

  /** The message as Gmail's API wants it: raw text, and the thread for a reply. */
  async function outgoing(ctx: ToolRunContext, input: Compose) {
    let threadId: string | undefined;
    let ids: string[] = [];
    if (input.reply_to_message_id) {
      const original = await request<Message>(
        ctx,
        `/messages/${input.reply_to_message_id}?${metadata(["Message-ID", "References"])}`,
        "find the message to reply to",
        undefined,
        noMessage(input.reply_to_message_id),
      );
      threadId = original.threadId;
      // Only well-formed IDs: these came from someone else's mail.
      ids = [header(original.payload, "References"), header(original.payload, "Message-ID")]
        .join(" ")
        .split(/\s+/)
        .filter((v) => MESSAGE_ID.test(v));
    }
    const raw = rawEmail({
      to: input.to,
      ...(input.cc ? { cc: input.cc } : {}),
      subject: input.subject,
      body: input.body,
      ...(ids.length ? { inReplyTo: ids.at(-1)!, references: ids.join(" ") } : {}),
    });
    return { raw, ...(threadId ? { threadId } : {}) };
  }

  const where = (input: Compose) =>
    `${input.to}${input.cc ? `, copying ${input.cc}` : ""}: “${input.subject || "(no subject)"}”`;

  const search = defineTool({
    name: "gmail.search_messages",
    description: [
      "Search the person's Gmail with Gmail's search syntax. Returns message IDs, dates, senders, subjects and snippets, newest first, and says when more match.",
      "Narrow the search rather than reading more: `category:primary` is mail from people (not promotions, social or updates), `-category:promotions` drops ads, `is:unread`, `newer_than:7d`, `from:sam`, `subject:invoice`, `has:attachment`, `is:important`. Combine them with spaces.",
      "If two or three searches find nothing that fits, stop and tell the person what you looked for, rather than searching on.",
    ].join(" "),
    input: z.object({
      query: z.string().max(500).default("in:inbox"),
      max: z.number().int().min(1).max(20).default(10),
      page_token: z
        .string()
        .max(200)
        .regex(/^[A-Za-z0-9_-]+$/, "a page token from a previous search")
        .optional()
        .describe("To see the next page of the same search: the token it gave"),
    }),
    annotations: { readOnly: true },
    source: "mcp",
    async run({ query, max, page_token }, ctx) {
      const found = await request<{
        messages?: { id: string }[];
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>(
        ctx,
        `/messages?q=${encodeURIComponent(query)}&maxResults=${max}${page_token ? `&pageToken=${page_token}` : ""}`,
        "search",
      );
      const ids = (found.messages ?? []).map((m) => m.id);
      if (ids.length === 0) {
        return {
          content: page_token ? "No more messages match." : "No messages match.",
          untrusted: true,
        };
      }
      const messages = await Promise.all(
        ids.map((messageId) =>
          request<Message>(
            ctx,
            `/messages/${encodeURIComponent(messageId)}?${metadata(["From", "Subject", "Date"])}`,
            "read a message",
          ),
        ),
      );
      const lines = messages.map((m) => {
        // Snippets arrive HTML-escaped and padded with invisible characters.
        const snippet = m.snippet ? readableText(htmlToText(m.snippet)).text : "";
        return [
          `${m.id} · ${header(m.payload, "Date")} · ${header(m.payload, "From")} · ${header(m.payload, "Subject") || "(no subject)"}`,
          snippet ? `  ${snippet}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      });
      // Without this the model takes the first page for the whole mailbox.
      if (found.nextPageToken) {
        const estimate = found.resultSizeEstimate ?? 0;
        lines.push(
          `…[${ids.length} shown${estimate > ids.length ? ` of about ${estimate}` : ""}; more match. Narrow the search, or call again with page_token: ${found.nextPageToken}]`,
        );
      }
      // Other people's words: the run is tainted from here (§10.3).
      return { content: lines.join("\n"), untrusted: true };
    },
  });

  const read = defineTool({
    name: "gmail.read_message",
    description: `Read one email by its message ID from gmail.search_messages, ${MAIL_CHUNK_CHARS.toLocaleString("en")} characters at a time. To read several, call this for each of them in the same step rather than one per step. Long tracking links are cut to their site; ask for full_links only when you need to open one.`,
    input: z.object({
      message_id: id("message"),
      from: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Character to start from, to read further into a long email"),
      full_links: z.boolean().default(false).describe("Show long links whole"),
    }),
    annotations: { readOnly: true },
    source: "mcp",
    async run({ message_id, from, full_links }, ctx) {
      const m = await request<Message>(
        ctx,
        `/messages/${encodeURIComponent(message_id)}?format=full`,
        "read that message",
        undefined,
        noMessage(message_id),
      );
      const files = attachments(m.payload);
      const { text: all, cut } = readableText(messageText(m.payload), full_links);
      const chunk = all.slice(from, from + MAIL_CHUNK_CHARS);
      const end = from + chunk.length;
      const notes = [
        ...(end < all.length
          ? [
              `characters ${from}–${end} of ${all.length}; call again with from: ${end} to read more`,
            ]
          : []),
        ...(cut
          ? [`${cut} long link${cut === 1 ? "" : "s"} cut; full_links: true shows them`]
          : []),
      ];
      const text = `${chunk || (from ? "(nothing more in this email)" : "")}${notes.length ? `\n…[${notes.join("; ")}]` : ""}`;
      const lines = [
        `From: ${header(m.payload, "From")}`,
        `To: ${header(m.payload, "To")}`,
        ...(header(m.payload, "Cc") ? [`Cc: ${header(m.payload, "Cc")}`] : []),
        `Date: ${header(m.payload, "Date")}`,
        `Subject: ${header(m.payload, "Subject")}`,
        `Message ID: ${m.id ?? message_id} · thread ${m.threadId ?? "?"}`,
        ...(files.length ? [`Attachments: ${files.join(", ")}`] : []),
        "",
        text || "(no text)",
      ];
      return { content: lines.join("\n"), untrusted: true };
    },
  });

  const createDraft = defineTool({
    name: "gmail.create_draft",
    description:
      "Save an email as a Gmail draft for the person to look at, without sending it. To reply in a thread, give reply_to_message_id.",
    input: compose,
    // Stays in the person's mailbox; a second copy after a crash is harmless.
    annotations: { readOnly: false, destructive: false, outbound: false, idempotent: true },
    source: "mcp",
    editable: ["subject", "body"],
    showArgs: true,
    describe: async (input) => `Save a Gmail draft to ${where(input)}`,
    async run(input, ctx) {
      const draft = await post<{ id?: string }>(ctx, "/drafts", "save the draft", {
        message: await outgoing(ctx, input),
      });
      return {
        content: `Saved draft ${draft.id ?? "?"}. It is in Drafts; gmail.send_draft sends it once the person approves.`,
        untrusted: false,
      };
    },
  });

  const sendEmail = defineTool({
    name: "gmail.send_email",
    description:
      "Send an email from the person's Gmail. The person sees it, can change the subject and message, and approves before it goes. To reply in a thread, give reply_to_message_id.",
    input: compose,
    annotations: { readOnly: false, destructive: false, outbound: true },
    source: "mcp",
    editable: ["subject", "body"],
    showArgs: true,
    describe: async (input) => `Send the email to ${where(input)}`,
    async run(input, ctx) {
      const sent = await post<{ id?: string; threadId?: string }>(
        ctx,
        "/messages/send",
        "send the email",
        await outgoing(ctx, input),
      );
      return {
        content: `Sent. Gmail message ${sent.id ?? "?"} in thread ${sent.threadId ?? "?"}.`,
        untrusted: false,
      };
    },
    // No `verify`: Gmail can't be asked whether this one went out, so after a
    // crash the executor says it can't tell rather than sending twice.
  });

  const getDraft = (ctx: ToolRunContext, draftId: string) =>
    mcp.fetchAs(
      ctx,
      serverId,
      `${api}/drafts/${encodeURIComponent(draftId)}?${metadata(["To", "Cc", "Bcc", "Subject"])}`,
    );

  const sendDraft = defineTool({
    name: "gmail.send_draft",
    description:
      "Send one of the person's Gmail drafts, exactly as it is, by its draft ID (from gmail.create_draft). The person approves before it goes.",
    input: z.object({ draft_id: id("draft") }),
    annotations: { outbound: true },
    source: "mcp",
    async run({ draft_id }, ctx) {
      const sent = await post<{ id?: string; threadId?: string }>(
        ctx,
        "/drafts/send",
        "send that draft",
        { id: draft_id },
      );
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
      const payload = draft.message?.payload;
      const to = header(payload, "To") || "(no recipient)";
      const cc = [header(payload, "Cc"), header(payload, "Bcc")].filter(Boolean).join(", ");
      const subject = header(payload, "Subject") || "(no subject)";
      const snippet = draft.message?.snippet?.trim();
      return `Send the email “${subject}” to ${to}${cc ? `, copying ${cc}` : ""}${snippet ? `\n${snippet}` : ""}`;
    },
  });

  return [search, read, createDraft, sendEmail, sendDraft] as unknown as ToolDefinition<unknown>[];
}
