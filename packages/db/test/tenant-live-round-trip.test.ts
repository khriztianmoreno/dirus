import { Pool } from "pg";
import { describe, expect, it } from "vitest";

/**
 * design.md D-A enforcement: "A second test proves the round trip: set
 * app.broker_id inside a transaction, read it back, commit, then assert it
 * is unset on the next checkout of the same pool."
 *
 * This is the one guarantee no mock can prove — it depends on Postgres
 * actually discarding a `set_config(..., true)` value when its owning
 * transaction ends, which is exactly what protects DIRUS from cross-tenant
 * leakage under PgBouncer transaction-mode pooling. `test/tenant.test.ts`
 * covers the SQL shape (mocked); this test covers the real guarantee
 * against a real Postgres connection.
 *
 * Requires `LIVE_TEST_DATABASE_URL` pointing at a reachable Postgres
 * instance (Neon or otherwise — pool-checkout leak behavior is not
 * Neon-specific, unlike the RLS integration tests in Phase 6). Deliberately
 * a separate var from `DATABASE_URL` / `DATABASE_URL_UNPOOLED` so this test
 * never silently runs against `test/setup.ts`'s placeholder default.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable
 * (sandboxed apply run, no `.env` access, no `LIVE_TEST_DATABASE_URL` set).
 * Per instructions, this is reported as skipped, not silently weakened or
 * claimed green.
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

describe.skipIf(!liveUrl)(
  "withBrokerContext round trip against a live Postgres connection (design.md D-A)",
  () => {
    it("does not leak app.broker_id to the next checkout of the same pooled connection", async () => {
      // max: 1 forces every checkout below onto the same physical
      // connection, which is the exact scenario a PgBouncer transaction-mode
      // pool multiplexes across unrelated requests.
      const pool = new Pool({ connectionString: liveUrl, max: 1 });
      try {
        const brokerId = "123e4567-e89b-12d3-a456-426614174000";

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("select set_config('app.broker_id', $1, true)", [brokerId]);
          const inside = await client.query<{ v: string | null }>(
            "select current_setting('app.broker_id', true) as v",
          );
          expect(inside.rows[0]?.v).toBe(brokerId);
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        const afterCommit = await pool.query<{ v: string | null }>(
          "select current_setting('app.broker_id', true) as v",
        );
        expect(afterCommit.rows[0]?.v ?? "").toBe("");
      } finally {
        await pool.end();
      }
    });
  },
);
