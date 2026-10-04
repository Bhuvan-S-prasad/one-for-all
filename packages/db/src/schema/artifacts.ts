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
 * Stored in Postgres in self-host; cloud mode can move content to object
 * storage behind the same `ArtifactStore` port.
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
    content: bytea("content").notNull(),
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
    check("artifact_size_ck", sql`${t.size} >= 0 and ${t.size} <= 10485760`),
    index("artifact_workspace_run_idx").on(t.workspaceId, t.runId),
  ],
);
