import type { IncomingMessage, ServerResponse } from "node:http";

// Just enough of the Gmail API for the Gmail tools (ADR-0031), in memory:
// search, read, drafts and sending. Sent mail is decoded from the `raw`
// message the tools build, so tests see exactly what would go out.

export interface FakeEmail {
  readonly id: string;
  readonly threadId?: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Send the body as HTML only, like many newsletters. */
  readonly html?: boolean;
  readonly messageId?: string;
}

/** A message as it went out, decoded from what the tool built. */
export interface SentEmail {
  readonly headers: Readonly<Record<string, string>>;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly threadId: string | null;
}

export interface FakeGmail {
  addMessage(message: FakeEmail): void;
  addDraft(id: string, draft: { to: string; subject: string; body: string }): void;
  /** Drafts sent with drafts.send, by ID. */
  readonly sentDrafts: string[];
  /** Messages sent with messages.send. */
  readonly sent: SentEmail[];
  /** Drafts saved with drafts.create, decoded. */
  readonly saved: SentEmail[];
}

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** "=?UTF-8?B?...?=" back to text. */
function decodeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_m, data: string) =>
    Buffer.from(data, "base64").toString("utf8"),
  );
}

/** A `raw` message back into headers and text, as a mail client would read it. */
export function parseRaw(raw: string, threadId: string | null): SentEmail {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  const head = split < 0 ? text : text.slice(0, split);
  const rest = split < 0 ? "" : text.slice(split + 4);
  const headers: Record<string, string> = {};
  for (const line of head.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body =
    headers["content-transfer-encoding"]?.toLowerCase() === "base64"
      ? Buffer.from(rest.replace(/\r\n/g, ""), "base64").toString("utf8")
      : rest;
  return {
    headers,
    to: headers.to ?? "",
    subject: decodeWords(headers.subject ?? ""),
    body: body.replace(/\r\n/g, "\n"),
    threadId,
  };
}

export function createFakeGmail(): FakeGmail & {
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: () => Promise<string>,
  ): Promise<void>;
} {
  const messages: FakeEmail[] = [];
  const drafts = new Map<string, { to: string; subject: string; body: string }>();
  const sentDrafts: string[] = [];
  const sent: SentEmail[] = [];
  const saved: SentEmail[] = [];
  let ids = 0;
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const headersOf = (m: FakeEmail) => [
    { name: "From", value: m.from },
    { name: "To", value: m.to },
    { name: "Subject", value: m.subject },
    { name: "Date", value: "Wed, 7 Oct 2026 09:00:00 +0000" },
    { name: "Message-ID", value: m.messageId ?? `<${m.id}@mail.example>` },
  ];

  return {
    addMessage: (m) => void messages.unshift(m),
    addDraft: (id, draft) => void drafts.set(id, draft),
    sentDrafts,
    sent,
    saved,

    async handle(req, res, url, body) {
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      if (path === "/messages" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const words = q.split(/\s+/).filter((w) => w && !w.includes(":"));
        const from = /from:(\S+)/.exec(q)?.[1];
        const all = messages
          .filter((m) => !from || m.from.toLowerCase().includes(from))
          .filter((m) => words.every((w) => `${m.subject} ${m.body}`.toLowerCase().includes(w)));
        // Page tokens are the offset, which is enough to test paging.
        const start = Number(url.searchParams.get("pageToken")?.replace("p", "") ?? 0);
        const end = start + Number(url.searchParams.get("maxResults") ?? 100);
        const found = all.slice(start, end);
        return json(res, 200, {
          ...(found.length
            ? { messages: found.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })) }
            : {}),
          ...(end < all.length ? { nextPageToken: `p${end}` } : {}),
          resultSizeEstimate: all.length,
        });
      }
      const message = /^\/messages\/([^/]+)$/.exec(path);
      if (message && req.method === "GET") {
        const m = messages.find((x) => x.id === decodeURIComponent(message[1]!));
        if (!m) {
          return json(res, 404, {
            error: { code: 404, message: "Requested entity was not found." },
          });
        }
        const full = url.searchParams.get("format") === "full";
        const part = m.html
          ? { mimeType: "text/html", body: { data: b64url(`<p>${m.body}</p>`) } }
          : { mimeType: "text/plain", body: { data: b64url(m.body) } };
        return json(res, 200, {
          id: m.id,
          threadId: m.threadId ?? m.id,
          snippet: m.body.slice(0, 80),
          payload: {
            mimeType: "multipart/alternative",
            headers: headersOf(m),
            ...(full ? { parts: [part] } : {}),
          },
        });
      }
      if (path === "/messages/send" && req.method === "POST") {
        const { raw, threadId } = JSON.parse(await body()) as { raw: string; threadId?: string };
        const email = parseRaw(raw, threadId ?? null);
        sent.push(email);
        ids += 1;
        return json(res, 200, { id: `sent_${ids}`, threadId: threadId ?? `thread_sent_${ids}` });
      }
      if (path === "/drafts" && req.method === "POST") {
        const { message: draft } = JSON.parse(await body()) as {
          message: { raw: string; threadId?: string };
        };
        const email = parseRaw(draft.raw, draft.threadId ?? null);
        saved.push(email);
        ids += 1;
        const id = `draft_${ids}`;
        drafts.set(id, { to: email.to, subject: email.subject, body: email.body });
        return json(res, 200, { id, message: { id: `m_${id}` } });
      }
      if (path === "/drafts/send" && req.method === "POST") {
        const { id } = JSON.parse(await body()) as { id: string };
        if (!drafts.delete(id)) return json(res, 404, { error: { code: 404 } });
        sentDrafts.push(id);
        return json(res, 200, { id: `msg_${id}`, threadId: `thread_${id}` });
      }
      const draftPath = /^\/drafts\/([^/]+)$/.exec(path);
      if (draftPath && req.method === "GET") {
        const id = decodeURIComponent(draftPath[1]!);
        const draft = drafts.get(id);
        if (!draft) return json(res, 404, { error: { code: 404 } });
        return json(res, 200, {
          id,
          message: {
            snippet: draft.body.slice(0, 100),
            payload: {
              headers: [
                { name: "To", value: draft.to },
                { name: "Subject", value: draft.subject },
              ],
            },
          },
        });
      }
      return json(res, 404, { error: { code: 404 } });
    },
  };
}
