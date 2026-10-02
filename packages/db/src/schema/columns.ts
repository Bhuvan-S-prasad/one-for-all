import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

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

/**
 * pgvector column without a fixed dimension. The embedding model is
 * replaceable, so rows record which model made them (`embedding_model`), and
 * similarity indexes are built per model as expression indexes, e.g.
 * `((embedding::vector(768))) WHERE embedding_model = '…'`.
 */
export const embedding = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => value.slice(1, -1).split(",").map(Number),
});
