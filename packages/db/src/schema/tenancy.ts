import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, id, timestampAt, updatedAt } from "./columns";
import { devicePlatform, membershipRole } from "./enums";

/** The tenant. Every other tenant table points here (ADR-0001). */
export const workspace = pgTable("workspace", {
  id: id(),
  name: text("name").notNull(),
  /** Where routines and reminders read clock times by default (M5.06). */
  timeZone: text("time_zone").notNull().default("UTC"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * `workspace_id` column for tenant tables. Row-level security filters on it
 * (migrations/0001_row_level_security.sql).
 */
export const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" });

/** A user's role in a workspace. The only link between identity and tenant. */
export const membership = pgTable(
  "membership",
  {
    id: id(),
    workspaceId: workspaceId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull().default("member"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("membership_workspace_user_uq").on(t.workspaceId, t.userId),
    index("membership_user_id_idx").on(t.userId),
  ],
);

/** A paired phone or browser (M6). Revocable from Settings. */
export const device = pgTable(
  "device",
  {
    id: id(),
    workspaceId: workspaceId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: devicePlatform("platform").notNull(),
    pushToken: text("push_token"),
    lastSeenAt: timestampAt("last_seen_at"),
    revokedAt: timestampAt("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("device_workspace_user_idx").on(t.workspaceId, t.userId)],
);
