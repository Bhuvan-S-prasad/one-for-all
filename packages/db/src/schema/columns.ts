import { timestamp, uuid } from "drizzle-orm/pg-core";

/** Primary key for tables we own. Auth tables use text IDs (see auth.ts). */
export const id = () => uuid("id").primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Optional point in time, e.g. `revoked_at`, `ended_at`. */
export const timestampAt = (name: string) => timestamp(name, { withTimezone: true });
