import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { createdAt, id } from "./columns";
import { run } from "./runs";
import { workspaceId } from "./tenancy";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * What a run produced that is too big for the context or worth keeping
 * (M3.06, ARCHITECTURE.md §7): long tool output the agent can reopen with
 * `artifact://<id>`, and files it wrote, which people can open from the chat.
 * Small ones are stored in Postgres; content over 1 MB goes to the object
 * store when one is set up (ADR-0047), and the row keeps its key.
 */
export const artifact = pgTable(
  "artifact",
  {
    id: id(),
    workspaceId: workspaceId(),
    runId: uuid("run_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** Chosen by the writer from the tool call's idempotency key: a retried step finds its artifact. */
    key: text("key").notNull(),
    /** `output`: long tool output. `file`: a file the agent wrote. */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** The content came from outside the system (a page, a command's output). */
    untrusted: boolean("untrusted").notNull(),
    /** The bytes, up to 1 MB when an object store is set up (else up to 10 MB)... */
    content: bytea("content"),
    /** ...or where they are in the object store (ADR-0047). Exactly one is set. */
    blobKey: text("blob_key"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "artifact_run_fk",
      columns: [t.workspaceId, t.runId],
      foreignColumns: [run.workspaceId, run.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artifact_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    unique("artifact_run_key_uq").on(t.runId, t.key),
    check("artifact_kind_ck", sql`${t.kind} in ('output', 'file')`),
    check(
      "artifact_size_ck",
      sql`${t.size} >= 0 and (${t.blobKey} is not null or ${t.size} <= 10485760)`,
    ),
    check("artifact_bytes_ck", sql`(${t.content} is null) <> (${t.blobKey} is null)`),
    index("artifact_workspace_run_idx").on(t.workspaceId, t.runId),
  ],
);
