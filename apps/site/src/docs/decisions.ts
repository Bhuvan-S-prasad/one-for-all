// The decision records, read from docs/adr at build time so the site never
// keeps a copy that drifts. Each record's own header gives its title, status,
// date and area.

const files = import.meta.glob("../../../../docs/adr/[0-9][0-9][0-9][0-9]-*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface Decision {
  /** "0044" */
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly status: string;
  readonly date: string;
  readonly area: string;
  /** The record without its title and header list. */
  readonly body: string;
}

function field(text: string, name: string): string {
  return new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, "m").exec(text)?.[1]?.trim() ?? "";
}

export const DECISIONS: readonly Decision[] = Object.entries(files)
  .map(([path, text]) => {
    const file = path.split("/").pop() ?? path;
    const id = file.slice(0, 4);
    const title = (/^# ADR-\d+:\s*(.+)$/m.exec(text)?.[1] ?? file).trim();
    // The body starts at the first section heading, after the header list.
    const start = text.search(/^## /m);
    return {
      id,
      file,
      title,
      status: field(text, "Status"),
      date: field(text, "Date"),
      area: field(text, "Area"),
      body: start >= 0 ? text.slice(start) : text,
    };
  })
  .filter((d) => d.id !== "0000")
  .sort((a, b) => a.id.localeCompare(b.id));

export const decisionById = new Map(DECISIONS.map((d) => [d.id, d]));
