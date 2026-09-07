import { sql } from "drizzle-orm";
import type { TenantDb } from "@dirus/db";
import type { MetricResult } from "./types.js";

/**
 * `admin-dashboard` (C1) task 6.2, design.md D-F, product-metrics spec §12
 * metric 1 ("Copilot usage — `conversations.kind = 'copilot'` volume").
 *
 * Takes `tx: TenantDb` directly, never `brokerId` — it NEVER opens its own
 * `withBrokerContext` (task 6.16's reentrancy-guard note; `tenant.ts`
 * throws on a nested call). The caller (this phase's route wiring, in
 * `apps/api/src/index.ts`) is the one that opens `withBrokerContext(
 * brokerId, copilotShare)` — `copilotShare`'s own signature is exactly the
 * `(tx: TenantDb) => Promise<T>` shape `withBrokerContext`'s `fn` parameter
 * expects, so that wiring is a one-line partial application, not a new
 * abstraction.
 *
 * RLS (already applied by `withBrokerContext`'s `set_config('app.broker_id',
 * ...)`) scopes this bare `count(*)` to the caller's own broker — no
 * explicit `WHERE broker_id = ...` is needed or added here, matching every
 * other `TenantDb`-scoped read in this codebase.
 *
 * `count(*)::int` avoids `pg`'s default bigint-as-string coercion for
 * `count(*)` — no row count in this table is realistically going to
 * overflow a 32-bit int, and every other metric in this phase does the
 * same cast for the same reason.
 */
export async function copilotShare(tx: TenantDb): Promise<MetricResult<{ count: number }>> {
  const result = await tx.execute<{ count: number | string }>(
    sql`select count(*)::int as count from conversations where kind = 'copilot'`,
  );

  const count = Number(result.rows[0]?.count ?? 0);

  return {
    value: { count },
    sampleSize: count,
    empty: count === 0,
    // H1/O8: this is a raw count of copilot conversations, not a SHARE —
    // total conversation volume is not yet instrumented as a denominator,
    // so any "share"/percentage framing in a consuming UI would be
    // fabricating a denominator this query does not have.
    caveat:
      "H1: this is a raw count of copilot conversations, not a percentage share — the total-conversation-volume denominator is not yet instrumented.",
  };
}
