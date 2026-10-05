// Where an address came from (ARCHITECTURE.md §10.3). In a run that read
// outside content, a page can tell the agent to open an address it builds
// itself, with the person's data in it: that is sending data out. So policy
// lets a run open, without asking, only addresses it was given: in the
// person's messages, or in what its tools returned (search results, pages).
// By hand: core uses no platform APIs (no URL).

const URL_PATTERN = /https?:\/\/[^\s"'<>`\\)\]}]+/gi;

/** Every http(s) address in a text, without trailing punctuation. */
export function urlsIn(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map((u) => u.replace(/[.,;:!?*_]+$/, ""));
}

/**
 * The same address however it was written: scheme and host in lower case,
 * no `www.`, no fragment, no trailing slash.
 */
export function urlKey(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)/i.exec(url.trim());
  if (!match) return url.trim();
  const [, scheme = "", host = "", rest = ""] = match;
  const path = rest.replace(/\/+(?=\?|$)/, "");
  return `${scheme.toLowerCase()}://${host.toLowerCase().replace(/^www\./, "")}${path}`;
}
