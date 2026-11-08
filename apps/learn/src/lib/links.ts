// Where each kind of thing lives in the app. Every page links through these.

export const symbolHref = (id: string) => `/symbol?id=${encodeURIComponent(id)}`;
export const fileHref = (path: string, line?: number) =>
  `/file?path=${encodeURIComponent(path)}${line ? `#L${line}` : ""}`;
export const packageHref = (key: string) => `/code/${encodeURIComponent(key)}`;
export const tableHref = (name: string) => `/data#table-${name}`;
export const routeHref = (method: string, path: string) =>
  `/api#${method.toLowerCase()}-${path.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}`;
export const decisionHref = (id: string) => `/decisions/${id}`;
export const pageHref = (ref: string) => `/${ref}`;

/** An ID like `path#Name` (or a file path) as a short label. */
export function shortName(id: string): string {
  const hash = id.indexOf("#");
  return hash < 0 ? (id.split("/").pop() ?? id) : id.slice(hash + 1);
}

/** The repository on GitHub, for "view on GitHub". */
export const REPO_URL = "https://github.com/Bhuvan-S-prasad/one-for-all";
export const repoFile = (path: string, line?: number) =>
  `${REPO_URL}/blob/main/${path}${line ? `#L${line}` : ""}`;
