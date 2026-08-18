import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertThrowawayDatabase } from "./assert-throwaway-database.js";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Runs the real CLI entrypoint (`tsx scripts/migrate.ts`) as a subprocess,
 * exactly how `pnpm db:migrate` invokes it — not an in-process
 * `import("../../scripts/migrate.js")`. `runMigrations()` dynamically
 * imports `../src/internal/admin.js` and closes its pool in a `finally`,
 * and ES module imports are cached per-process; calling `runMigrations()`
 * twice in the same test process would reuse (and crash against) an
 * already-`end()`ed pool on the second call. A fresh subprocess per
 * invocation sidesteps that entirely and matches real usage.
 */
function runMigrateCli(): string {
  return execFileSync("pnpm", ["exec", "tsx", "scripts/migrate.ts"], {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL_UNPOOLED: runnerLiveUrl },
  });
}

/**
 * design.md D-G, happy path: `pnpm db:migrate` (`scripts/migrate.ts`)
 * applied end-to-end against a real, empty Postgres database — the one
 * case none of the other migration tests exercise, since they all read
 * committed migration SQL as text or apply hand-picked files directly
 * (`live-rls-verification.test.ts`, `rls-catalog-guard.test.ts`). This
 * proves the actual runner (guards 1-3 + the Drizzle migrator, in order)
 * against a live connection, not just its individually-tested guard
 * functions (`migrate-guards.test.ts`, offline).
 *
 * Deliberately gated on its own env var
 * (`MIGRATE_RUNNER_TEST_DATABASE_URL_UNPOOLED`), not the shared
 * `LIVE_TEST_DATABASE_URL` the other live suites use: those suites already
 * create/drop tables and throwaway schemas inside that database, and this
 * test needs a genuinely empty database (full-schema `CREATE TABLE`s via
 * the unmodified committed migration files, which hardcode `public`) —
 * running both against the same target would race and collide. Point this
 * variable at its own disposable database/container.
 */
const runnerLiveUrl = process.env.MIGRATE_RUNNER_TEST_DATABASE_URL_UNPOOLED;

describe.skipIf(!runnerLiveUrl)("scripts/migrate.ts runMigrations() (live happy path)", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: runnerLiveUrl });
    await admin.connect();
    try {
      await assertThrowawayDatabase(admin);
      // `0003_app_role_grants.sql` only grants to `dirus_app` if it already
      // exists (design.md D-F: role creation is a separate one-time step,
      // `scripts/provision-app-role.sql`, deliberately not part of the
      // committed migration sequence because it carries a password). Mirror
      // that one-time step here so the migration run below has a role to
      // grant to, and the happy-path assertions can prove the grant landed.
      await admin.query(
        "CREATE ROLE dirus_app WITH LOGIN PASSWORD 'migrate-runner-live-test' NOBYPASSRLS NOSUPERUSER",
      );
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    // Full teardown so a re-run against the same disposable container
    // starts from an empty database again, and so this test never leaves
    // behind a role/schema that could confuse an unrelated run.
    const admin = new Client({ connectionString: runnerLiveUrl });
    await admin.connect();
    try {
      await admin.query("DROP SCHEMA public CASCADE");
      await admin.query("CREATE SCHEMA public");
      await admin.query("DROP OWNED BY dirus_app").catch(() => {
        // dirus_app may not exist if 0003 never ran (e.g. an earlier guard
        // failed before reaching the migrator) — nothing to drop.
      });
      await admin.query("DROP ROLE IF EXISTS dirus_app");
    } finally {
      await admin.end();
    }
  });

  it("applies all four committed migrations in order and reaches a clean, fully-migrated state", async () => {
    const output = runMigrateCli();
    expect(output).toMatch(/Migrations applied successfully\./);

    const verify = new Client({ connectionString: runnerLiveUrl });
    await verify.connect();
    try {
      // 0000_init.sql: tables exist.
      const tables = await verify.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'brokers'",
      );
      expect(tables.rows).toHaveLength(1);

      // 0001_vector_extension.sql: pgvector installed.
      const extension = await verify.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      expect(extension.rows).toHaveLength(1);

      // 0002_rls_policies.sql: RLS is both enabled and forced on `brokers`.
      const rls = await verify.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'brokers'",
      );
      expect(rls.rows[0]?.relrowsecurity).toBe(true);
      expect(rls.rows[0]?.relforcerowsecurity).toBe(true);

      // 0003_app_role_grants.sql: dirus_app exists and can SELECT.
      const role = await verify.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname = 'dirus_app'",
      );
      expect(role.rows).toHaveLength(1);
    } finally {
      await verify.end();
    }
  });

  it("is idempotent: running it again against an already-migrated database is a no-op, not an error", () => {
    const output = runMigrateCli();
    expect(output).toMatch(/Migrations applied successfully\./);
  });
});
