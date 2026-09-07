import { and, eq } from "drizzle-orm";
import { schema, withBrokerContext } from "@dirus/db";

/**
 * `admin-dashboard` (C1) task 5.12, extraction-review spec "Reviewer
 * Correction Writes Back correctedOutput and correctedBy" and "Resolving a
 * Correction Clears needs_review". The real write behind
 * `routes/dashboard/review-queue.ts`'s injected `CorrectExtractionFn`.
 *
 * Writes EXACTLY the caller-supplied `correctedOutput` verbatim — no
 * merge with `output`, no fill-in from `confidence`, no other computed
 * value (task 5.14, spec "A low-confidence field is never auto-accepted
 * without human input"). `correctedBy` and `brokerId` are both caller
 * params, never read from this function's own logic — the route (task
 * 5.9) is what guarantees `correctedBy` is always the session's own
 * `broker_user_id`, never client-supplied; this function has no opinion on
 * where its params came from.
 *
 * `AND broker_id = ...` is defense-in-depth alongside RLS (mirrors
 * `import-policies-writer.ts`'s `upsertPolicy` scoping convention) — a
 * caller-supplied `extractionId` belonging to a different broker matches
 * zero rows here, never another broker's row, even though RLS alone would
 * already enforce this under `withBrokerContext`.
 */
export type CorrectExtractionParams = {
  brokerId: string;
  extractionId: string;
  correctedOutput: Record<string, unknown>;
  correctedBy: string;
};

export type CorrectExtractionResult = { found: boolean };

export async function correctExtraction(params: CorrectExtractionParams): Promise<CorrectExtractionResult> {
  return withBrokerContext(params.brokerId, async (tx) => {
    const [updated] = await tx
      .update(schema.extractions)
      .set({
        correctedOutput: params.correctedOutput,
        correctedBy: params.correctedBy,
        needsReview: false,
      })
      .where(
        and(
          eq(schema.extractions.id, params.extractionId),
          eq(schema.extractions.brokerId, params.brokerId),
        ),
      )
      .returning({ id: schema.extractions.id });

    return { found: updated !== undefined };
  });
}
