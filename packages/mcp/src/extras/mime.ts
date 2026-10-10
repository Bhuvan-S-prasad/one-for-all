// Plain-text email, built for the Gmail API's `raw` field (ADR-0031). Header
// values come from a model that may have read hostile mail, so nothing it
// writes can start a new header: line breaks are refused outright, addresses
// must look like addresses, and non-ASCII text is encoded rather than passed
// through. The body is base64, so its content never reads as headers either.

export class MimeError extends Error {
  readonly code = "invalid_args";
}

export interface PlainEmail {
  /** Comma-separated: `sam@example.com` or `Sam Rivera <sam@example.com>`. */
  readonly to: string;
  readonly cc?: string;
  readonly subject: string;
  readonly body: string;
  /** For a reply: the original's `Message-ID`, and its `References` chain. */
  readonly inReplyTo?: string;
  readonly references?: string;
}

const MAX_RECIPIENTS = 20;
const ADDRESS = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/;
/** `<id@host>`, as in Message-ID and References. */
export const MESSAGE_ID = /^<[^<>\s]{3,250}>$/;

function noLineBreaks(field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new MimeError(`${field} can't contain line breaks`);
}

/** RFC 2047 for anything outside printable ASCII; plain text otherwise. */
export function encodeWord(text: string): string {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** Checked recipients, one per entry, in header form. */
export function parseRecipients(field: string, list: string): string[] {
  noLineBreaks(field, list);
  const items = list
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length > MAX_RECIPIENTS) {
    throw new MimeError(`${field}: at most ${MAX_RECIPIENTS} recipients`);
  }
  return items.map((item) => {
    const named = /^(.*?)\s*<([^<>]+)>$/.exec(item);
    const address = (named ? named[2] : item)!.trim();
    if (!ADDRESS.test(address)) throw new MimeError(`${field}: "${item}" isn't an email address`);
    const name = named?.[1]?.replace(/^"|"$/g, "").trim();
    if (!name) return address;
    if (/["\\<>]/.test(name))
      throw new MimeError(`${field}: the name in "${item}" has odd characters`);
    const encoded = encodeWord(name);
    return encoded === name ? `"${name}" <${address}>` : `${encoded} <${address}>`;
  });
}

function wrap(base64: string): string {
  return base64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/** The whole message, CRLF line ends, ready to base64url into `raw`. */
export function buildPlainEmail(email: PlainEmail): string {
  const to = parseRecipients("To", email.to);
  if (to.length === 0) throw new MimeError("To needs at least one address");
  const cc = email.cc ? parseRecipients("Cc", email.cc) : [];
  noLineBreaks("Subject", email.subject);
  if (email.subject.length > 500) throw new MimeError("Subject is too long");
  const headers = [`To: ${to.join(", ")}`];
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  headers.push(`Subject: ${encodeWord(email.subject.trim())}`);
  for (const [name, value] of [
    ["In-Reply-To", email.inReplyTo],
    ["References", email.references],
  ] as const) {
    if (!value) continue;
    const ids = value.trim().split(/\s+/);
    if (!ids.every((id) => MESSAGE_ID.test(id))) throw new MimeError(`${name} isn't a message ID`);
    headers.push(`${name}: ${ids.slice(-20).join(" ")}`);
  }
  headers.push(
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  );
  const body = email.body.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${wrap(Buffer.from(body, "utf8").toString("base64"))}\r\n`;
}

/** The Gmail API's `raw`: the message as base64url. */
export function rawEmail(email: PlainEmail): string {
  return Buffer.from(buildPlainEmail(email), "utf8").toString("base64url");
}
