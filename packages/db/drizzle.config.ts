import { defineConfig } from "drizzle-kit";

/**
 * design.md D-G: migrations are generated against `DATABASE_URL_UNPOOLED`
 * (direct Neon connection) — DDL must not cross a transaction pooler.
 * `drizzle-kit generate` only reads the schema to diff against
 * `migrations/meta`, it never opens `dbCredentials` for that command, but
 * `drizzle-kit check`/`push` do, so the same unpooled var is used here for
 * consistency with `scripts/migrate.ts` (Phase 5).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? "postgres://placeholder/placeholder",
  },
});
