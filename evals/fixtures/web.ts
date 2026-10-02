import type { Fetcher, SearchResult, WebSearchProvider } from "@ofa/tools";

// A recorded slice of the web. Evals never touch the real internet or real
// accounts (ARCHITECTURE.md §12): searches and page reads come from here.

export interface WebFixture {
  /** Results for any query that mentions one of `match` (case-insensitive). */
  readonly searches: readonly {
    readonly match: readonly string[];
    readonly results: readonly SearchResult[];
  }[];
  /** Page bodies by URL. Anything else is a 404. */
  readonly pages: Readonly<Record<string, string>>;
}

export function fixtureSearch(web: WebFixture): WebSearchProvider {
  return {
    async search(query, { limit }) {
      const q = query.toLowerCase();
      const hit = web.searches.find((s) => s.match.some((m) => q.includes(m.toLowerCase())));
      return (hit?.results ?? []).slice(0, limit);
    },
  };
}

/** Normalise so `https://x.org/a/` and `https://x.org/a` are the same page. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

export function fixtureFetcher(web: WebFixture): Fetcher {
  const pages = new Map(Object.entries(web.pages).map(([url, body]) => [pageKey(url), body]));
  return async (url) => {
    const body = pages.get(pageKey(url));
    return {
      url,
      status: body === undefined ? 404 : 200,
      contentType: "text/html; charset=utf-8",
      body: body ?? "<html><body><h1>Not found</h1></body></html>",
      truncated: false,
    };
  };
}

/** A small HTML page around some paragraphs. */
export function page(title: string, ...paragraphs: string[]): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${paragraphs
    .map((p) => `<p>${p}</p>`)
    .join("")}</main></body></html>`;
}
