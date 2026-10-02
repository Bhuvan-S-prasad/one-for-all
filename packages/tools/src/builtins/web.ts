import { z } from "zod";
import { defineTool } from "../define";
import { htmlTitle, htmlToText } from "./html";
import { safeFetch, type SafeResponse } from "./safe-fetch";

// web.search and web.read_url (ARCHITECTURE.md §9.3). Both return content
// from outside the system, so both mark the run tainted (§10.3).

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Where searches go. SearXNG by default; Tavily or Exa can implement this later. */
export interface WebSearchProvider {
  search(query: string, options: { readonly limit: number }): Promise<SearchResult[]>;
}

/** Self-hosted SearXNG (JSON API must be enabled in its settings). */
export function createSearxngProvider(options: {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}): WebSearchProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const resultSchema = z.object({
    results: z.array(
      z.object({ title: z.string().default(""), url: z.string(), content: z.string().nullish() }),
    ),
  });
  return {
    async search(query, { limit }) {
      const url = new URL("/search", options.baseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("safesearch", "1");
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);
      const body = resultSchema.parse(await response.json());
      const seen = new Set<string>();
      return body.results
        .filter((r) => !seen.has(r.url) && seen.add(r.url))
        .slice(0, limit)
        .map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 300) }));
    },
  };
}

export function webSearchTool(provider: WebSearchProvider | null) {
  return defineTool({
    name: "web.search",
    description:
      "Search the web. Returns titles, URLs and short snippets. Use web.read_url to read a result in full.",
    input: z.object({
      query: z.string().trim().min(2).max(300).describe("What to search for"),
      max_results: z.number().int().min(1).max(10).default(5),
    }),
    annotations: { readOnly: true, idempotent: true },
    async run({ query, max_results }) {
      if (!provider) {
        throw Object.assign(new Error("Web search is not set up on this server (SEARXNG_URL)."), {
          code: "not_configured",
        });
      }
      const results = await provider.search(query, { limit: max_results });
      return { content: results.length ? results : "No results.", untrusted: true };
    },
  });
}

export type Fetcher = (url: string) => Promise<SafeResponse>;

export function readUrlTool(fetcher: Fetcher = (url) => safeFetch(url)) {
  return defineTool({
    name: "web.read_url",
    description:
      "Read a web page or text document and return its text. Public http(s) addresses only.",
    input: z.object({ url: z.url().max(2_000).describe("The page to read") }),
    annotations: { readOnly: true, idempotent: true },
    async run({ url }) {
      const page = await fetcher(url);
      if (page.status >= 400) {
        throw Object.assign(new Error(`The page answered HTTP ${page.status}`), {
          code: "http_error",
        });
      }
      const type = page.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      let text: string;
      if (type === "text/html" || type === "application/xhtml+xml") {
        const title = htmlTitle(page.body);
        text = `${title ? `# ${title}\n\n` : ""}${htmlToText(page.body)}`;
      } else if (type.startsWith("text/") || type === "application/json" || type === "") {
        text = page.body;
      } else {
        throw Object.assign(new Error(`Can't read ${type} documents yet`), {
          code: "unsupported_type",
        });
      }
      return {
        content: `Source: ${page.url}\n\n${text}${page.truncated ? "\n…[page cut at 2 MB]" : ""}`,
        untrusted: true,
      };
    },
  });
}
