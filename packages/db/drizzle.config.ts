import { defineConfig } from "drizzle-kit";
import { loadRootEnv } from "./src/env";

loadRootEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Migrations are generated and applied as the owner role.
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
