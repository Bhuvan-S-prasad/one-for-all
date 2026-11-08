import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, id } from "./columns";
import { workspaceId } from "./tenancy";
import { thread } from "./threads";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * A file a person attached to a chat (EN.09): footage, images, documents.
 * Kept like an artifact (ADR-0047): small ones in Postgres, larger ones in
 * the object store. It belongs to its chat; an agent copies it into its
 * computer with `files.receive` only in a run of that chat.
 */
export const upload = pgTable(
  "upload",
  {
    id: id(),
    workspaceId: workspaceId(),
    threadId: uuid("thread_id").notNull(),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    /** The message it was sent with; null until then. Set only by the API, in this chat. */
    messageId: uuid("message_id"),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    content: bytea("content"),
    blobKey: text("blob_key"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "upload_thread_fk",
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [thread.workspaceId, thread.id],
    }).onDelete("cascade"),
    check(
      "upload_size_ck",
      sql`${t.size} >= 0 and (${t.blobKey} is not null or ${t.size} <= 10485760)`,
    ),
    check("upload_bytes_ck", sql`(${t.content} is null) <> (${t.blobKey} is null)`),
    index("upload_thread_idx").on(t.workspaceId, t.threadId),
  ],
);
