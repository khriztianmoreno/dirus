import type { Client } from "pg";

/**
 * Judgment Day round 3 (WARNING, both judges): the destructive live-RLS
 * tests in this directory mutate a real table's live policy (`DROP POLICY` /
 * `CREATE POLICY ... USING (true)`) and issue unqualified
 * `DROP TABLE ... CASCADE` against `LIVE_TEST_DATABASE_URL`. Nothing
 * previously stopped that variable from pointing at a real staging/
 * production connection string — `finally` blocks restore state on a clean
 * exit, but do not run across a hard process kill (Ctrl-C, OOM, or a GitHub
 * Actions `cancel-in-progress`, which this repo's workflow enables), which
 * could leave a real database with an always-true policy or missing tables.
 *
 * This guard runs before any destructive statement and refuses to proceed
 * unless the target database is provably a throwaway: its name ends in
 * `_test` or `_ci` (case-insensitive) — matching this repo's own CI
 * convention (`dirus_test`, see `.github/workflows/ci.yml`) — or the
 * developer has explicitly opted in via `ALLOW_DESTRUCTIVE_LIVE_TESTS=1`.
 */
export async function assertThrowawayDatabase(admin: Client): Promise<void> {
  if (process.env.ALLOW_DESTRUCTIVE_LIVE_TESTS === "1") {
    return;
  }
  const result = await admin.query<{ current_database: string }>("SELECT current_database()");
  const dbName = result.rows[0]?.current_database ?? "";
  if (!/(_test|_ci)$/i.test(dbName)) {
    throw new Error(
      `refusing to run destructive live RLS tests against database "${dbName}": its name ` +
        `does not end in "_test" or "_ci", so it cannot be proven to be a throwaway ` +
        `database. This test suite DROPs TABLEs, DROPs/CREATEs POLICYs, and DROPs ROLEs ` +
        `against LIVE_TEST_DATABASE_URL. Point LIVE_TEST_DATABASE_URL at a scratch database ` +
        `whose name ends in "_test" or "_ci", or set ALLOW_DESTRUCTIVE_LIVE_TESTS=1 to ` +
        `override at your own risk.`,
    );
  }
}
