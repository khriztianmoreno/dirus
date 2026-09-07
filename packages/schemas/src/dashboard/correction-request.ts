import { z } from "zod";

/**
 * `admin-dashboard` (C1) task 5.9-5.12, design.md D-E, extraction-review
 * spec "Reviewer Correction Writes Back correctedOutput and correctedBy".
 * `POST /dashboard/review-queue/:id/correction` request body.
 *
 * **Deliberately has NO `correctedBy` field.** The spec's non-negotiable
 * requirement is that `correctedBy` is ALWAYS the session's own
 * `broker_user_id`, never a client-supplied value (spec "correctedBy is
 * taken from the session, not the request body"). Zod's `z.object()` strips
 * unrecognized keys by default (no `.passthrough()`/`.strict()` here), so a
 * request body that includes a `correctedBy` field is silently dropped by
 * `safeParse` itself — the route never even sees it as a candidate value,
 * let alone reads it. This is a structural guarantee, not a runtime check:
 * there is no code path in this schema or the route that could read
 * `parsed.data.correctedBy`, because that key does not exist on the parsed
 * type.
 *
 * `correctedOutput` mirrors `extraction-envelope.ts`'s `value: unknown`
 * looseness — the corrected field values are only ever written back
 * verbatim (never re-validated against a field-specific type, since B2's
 * real per-field types do not exist yet either). Required (not
 * `.optional()`): a request with no `correctedOutput` key fails validation
 * (task 5.11, spec "A failed correction attempt leaves needs_review
 * unchanged").
 */
export const correctionRequestSchema = z.object({
  correctedOutput: z.record(z.string(), z.unknown()),
});

export type CorrectionRequest = z.infer<typeof correctionRequestSchema>;
