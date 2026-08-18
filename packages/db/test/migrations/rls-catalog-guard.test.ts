import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Judgment Day round 1 (scaffold-monorepo Phase 4): `0003_app_role_grants.sql`
 * auto-grants `dirus_app` full CRUD on every future table via
 * `ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES`, but nothing about that
 * grant is contingent on the table also being RLS-protected. A future
 * migration that adds a `broker_id`-carrying table and forgets the
 * `ENABLE`/`FORCE`/`CREATE POLICY` block from `0002_rls_policies.sql` ships
 * with silent cross-tenant read/write access: the grant is automatic, the
 * protection is manual. That asymmetry fails OPEN, the worst property for
 * multi-tenant isolation code.
 *
 * This test is the compensating control. It does NOT hardcode which tables
 * must be protected — `rls-policies.test.ts` already hardcodes today's nine
 * `broker_id` tables against the migration's own SQL text, which only
 * catches a regression in a table this repo already knows about. This test
 * instead asks the live Postgres catalog which tables in `public` actually
 * carry a `broker_id` column (plus `brokers`, keyed on `id`) and asserts
 * EVERY one of them — including a table that does not exist yet when this
 * file is written — has `relrowsecurity`, `relforcerowsecurity`, and a
 * policy whose `USING` and `WITH CHECK` both reference `app.broker_id`.
 *
 * Proven RED against the real defect before being proven GREEN: a
 * deliberately unprotected `broker_id` table was created (as the
 * table-owning role, exactly as a forgetful future migration would) after
 * applying 0000/0002, and this guard failed, naming that table, before the
 * table was removed. See apply-progress.md for the transcript.
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}

const OWNER_ROLE = "catalog_guard_owner";

const TABLES_DROP_ORDER = [
  "renewals",
  "extractions",
  "documents",
  "messages",
  "conversations",
  "contacts",
  "broker_users",
  "policies",
  "brokers",
];

async function dropFixture(admin: Client): Promise<void> {
  for (const table of TABLES_DROP_ORDER) {
    await admin.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
  await admin.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
        EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', '${OWNER_ROLE}');
        EXECUTE format('DROP OWNED BY %I', '${OWNER_ROLE}');
      END IF;
    END
    $$;
  `);
  await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
}

/** Rebuilds a connection string with a different user/password, same host/db. */
function rewriteUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

/**
 * Catalog-derived, not hand-maintained: enumerates every base table in
 * `public` that carries a `broker_id` column, plus `brokers` itself (keyed
 * on `id`, the tenant root). This is what makes the guard catch a table
 * this file's author never saw.
 */
async function discoverTenantTables(admin: Client): Promise<string[]> {
  const result = await admin.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND (
        c.relname = 'brokers'
        OR EXISTS (
          SELECT 1
          FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'broker_id'
        )
      )
    ORDER BY c.relname
  `);
  return result.rows.map((row) => row.table_name);
}

describe.skipIf(!liveUrl)("catalog-derived RLS guard (Judgment Day round 1)", () => {
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    // `live-rls-verification.test.ts` also applies 0000/0002 directly
    // against the same `public` schema table names (0000_init.sql's FKs are
    // fully-qualified to "public", so this can't be relocated via
    // search_path). Vitest runs test files in parallel workers, so this
    // session-level advisory lock keeps the two files from racing.
    await admin.query("SELECT pg_advisory_lock(478291)");

    await dropFixture(admin);

    await admin.query(`CREATE ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD 'catalog-guard-owner-pass' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER_ROLE}`);

    const owner = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, "catalog-guard-owner-pass") });
    await owner.connect();
    try {
      await owner.query(readMigration("0000_init.sql"));
      await owner.query(readMigration("0002_rls_policies.sql"));
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await dropFixture(admin);
    await admin.query("SELECT pg_advisory_unlock(478291)");
    await admin.end();
  });

  it("discovers a non-empty set of tenant tables (the guard is not vacuous)", async () => {
    const tables = await discoverTenantTables(admin);
    expect(tables.length).toBeGreaterThan(0);
  });

  it("protects every catalog-discovered broker_id (or brokers) table with ENABLE+FORCE RLS and an app.broker_id policy", async () => {
    const tables = await discoverTenantTables(admin);
    const violations: string[] = [];

    for (const table of tables) {
      const relInfo = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1`,
        [table],
      );
      const { relrowsecurity, relforcerowsecurity } = relInfo.rows[0] ?? {
        relrowsecurity: false,
        relforcerowsecurity: false,
      };

      const policies = await admin.query<{ qual: string | null; with_check: string | null }>(
        `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      const hasTenantPolicy = policies.rows.some(
        (row) => (row.qual ?? "").includes("app.broker_id") && (row.with_check ?? "").includes("app.broker_id"),
      );

      if (!relrowsecurity || !relforcerowsecurity || !hasTenantPolicy) {
        violations.push(table);
      }
    }

    expect(violations).toEqual([]);
  });
});
