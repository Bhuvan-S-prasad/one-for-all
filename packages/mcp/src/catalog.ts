import { z } from "zod";
import github from "../catalog/github.json";
import gmail from "../catalog/gmail.json";
import googleCalendar from "../catalog/google_calendar.json";
import googleDrive from "../catalog/google_drive.json";
import linear from "../catalog/linear.json";
import notion from "../catalog/notion.json";
import slack from "../catalog/slack.json";

// The reviewed catalog (ADR-0018): official remote MCP servers with pinned
// addresses and sign-in sites. Adding an app is a JSON file here, reviewed
// against docs/guides/catalog-review.md. Entries are checked when loaded, so
// a bad one fails at startup, not when someone presses Connect.

export const catalogEntrySchema = z.object({
  /** Also the slug: the app part of its tool names (`notion.search`). */
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.url().refine((u) => u.startsWith("https://"), "catalog servers use https"),
  /** Where sign-in must happen; anything else is refused. */
  authOrigin: z.url().refine((u) => new URL(u).origin === u, "an origin, without a path"),
  /**
   * `automatic`: the server registers us itself (dynamic client registration).
   * `own_client`: the self-hoster creates an OAuth app and enters its ID and secret.
   */
  setup: z.enum(["automatic", "own_client"]),
  /** Scopes to ask for; otherwise whatever the server advertises. */
  scopes: z.array(z.string().min(1)).optional(),
  /** Extra sign-in parameters (Google issues refresh tokens only with `access_type=offline`). */
  authorizationParams: z.record(z.string(), z.string()).optional(),
  /**
   * The app's own API, for tools we write beside its server's (ADR-0029):
   * the only origins its sign-in may be sent to directly.
   */
  apiOrigins: z
    .array(
      z
        .url()
        .refine(
          (u) => u.startsWith("https://") && new URL(u).origin === u,
          "an https origin, without a path",
        ),
    )
    .optional(),
  /** How to set it up, for `own_client` entries. */
  guide: z.string().optional(),
  /** When the entry was last checked against the server's published metadata. */
  reviewed: z.iso.date(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const CATALOG: readonly CatalogEntry[] = [
  notion,
  linear,
  github,
  slack,
  gmail,
  googleCalendar,
  googleDrive,
].map((entry) => catalogEntrySchema.parse(entry));

export function catalogEntry(id: string | null | undefined): CatalogEntry | undefined {
  return id ? CATALOG.find((entry) => entry.id === id) : undefined;
}
