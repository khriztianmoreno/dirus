import { sql } from "drizzle-orm";
import type { TenantDb } from "@dirus/db";
import type { MetricResult } from "./types.js";

/**
 * `admin-dashboard` (C1) task 6.8, design.md D-F, product-metrics spec §12
 * metric 3 ("Extraction review load — `extractions.needs_review`
 * count/rate"). Same `(tx: TenantDb) => Promise<MetricResult<T>>` shape as
 * `copilot-share.ts` — see that file's docstring for the reentrancy-guard
 * reasoning, identical here.
 *
 * `count(*) filter (where needs_review = true)` reads the same
 * `(broker_id, needs_review) WHERE needs_review = true` partial index
 * Phase 5's `needs-review-queue.ts` reads (`packages/db/src/schema/
 * extractions.ts`'s own docstring) — RLS already scopes `broker_id`, and
 * this `filter` clause matches that index's partial predicate exactly.
 */
export type NeedsReviewRateValue = { flagged: number; total: number; rate: number };

export async function needsReviewRate(tx: TenantDb): Promise<MetricResult<NeedsReviewRateValue>> {
  const result = await tx.execute<{ total: number | string; flagged: number | string }>(
    sql`select count(*)::int as total, count(*) filter (where needs_review = true)::int as flagged from extractions`,
  );

  const row = result.rows[0];
  const total = Number(row?.total ?? 0);
  const flagged = Number(row?.flagged ?? 0);

  return {
    value: { flagged, total, rate: total === 0 ? 0 : flagged / total },
    sampleSize: total,
    empty: total === 0,
  };
}
