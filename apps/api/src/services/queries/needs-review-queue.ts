import { and, eq } from "drizzle-orm";
import { schema, withBrokerContext } from "@dirus/db";

/**
 * `admin-dashboard` (C1) task 5.8, extraction-review spec "Review Queue
 * Lists Only Flagged Extractions". The real query behind
 * `routes/dashboard/review-queue.ts`'s injected `NeedsReviewQueueFn` — see
 * that route's own docstring for why `@dirus/db` never appears there
 * directly.
 *
 * `WHERE broker_id = ... AND needs_review = true` filters at the SQL layer,
 * RLS-scoped via `withBrokerContext` (belt-and-suspenders with the route's
 * OWN `needsReview === true` filter — the route never assumes an injected
 * query implementation filtered correctly, per its own test 5.6). Reuses
 * `packages/db/src/schema/extractions.ts`'s
 * `(broker_id, needs_review) WHERE needs_review = true` partial index
 * (also Phase 6's `needs-review-rate.ts` reader).
 */
export type ReviewQueueRow = {
  id: string;
  brokerId: string;
  output: unknown;
  confidence: unknown;
  needsReview: boolean;
};

export async function needsReviewQueue(brokerId: string): Promise<ReviewQueueRow[]> {
  return withBrokerContext(brokerId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.extractions.id,
        brokerId: schema.extractions.brokerId,
        output: schema.extractions.output,
        confidence: schema.extractions.confidence,
        needsReview: schema.extractions.needsReview,
      })
      .from(schema.extractions)
      .where(and(eq(schema.extractions.brokerId, brokerId), eq(schema.extractions.needsReview, true)));

    return rows;
  });
}
