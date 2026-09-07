import type { Hono } from "hono";
import { correctionRequestSchema } from "@dirus/schemas";
import type { AppVariables } from "../../app.js";
import { toEnvelope } from "../../services/to-envelope.js";
import type { CorrectExtractionParams, CorrectExtractionResult } from "../../services/queries/correct-extraction.js";
import type { ReviewQueueRow } from "../../services/queries/needs-review-queue.js";

// Re-exported so callers/tests only need this one module.
export type { ReviewQueueRow } from "../../services/queries/needs-review-queue.js";

/**
 * `admin-dashboard` (C1) tasks 5.6-5.12, design.md D-E, extraction-review
 * spec (all requirements). `GET /dashboard/review-queue` (list) and
 * `POST /dashboard/review-queue/:id/correction` (correct), colocated in one
 * file per design.md's Files table (`apps/api/src/routes/dashboard/
 * {review-queue,metrics}.ts` — "Read + correct endpoints", singular file
 * for the review queue).
 *
 * Mounted BEHIND `session-auth.ts` + `csrf-guard.ts` in `app.ts` — this
 * route itself never authenticates anything; it only reads
 * `c.var.brokerId`/`c.var.session`, exactly as those middlewares' own
 * contract states. `needsReviewQueue`/`correctExtraction` are injected
 * (never imported as VALUES from `services/queries/*.ts`, which pull in
 * `@dirus/db`), mirroring `policies-import.ts`'s `ImportPolicyRowsFn`
 * convention — only `index.ts` wires in the real implementations. The
 * `ReviewQueueRow`/`CorrectExtractionParams`/`CorrectExtractionResult`
 * imports above are TYPE-ONLY, erased at compile time, so they never reach
 * this module's runtime import graph either.
 */
export type NeedsReviewQueueFn = (brokerId: string) => Promise<ReviewQueueRow[]>;
export type CorrectExtractionFn = (params: CorrectExtractionParams) => Promise<CorrectExtractionResult>;

export type ReviewQueueRouteOptions = {
  needsReviewQueue: NeedsReviewQueueFn;
  correctExtraction: CorrectExtractionFn;
};

export function registerReviewQueueRoute(
  app: Hono<{ Variables: AppVariables }>,
  { needsReviewQueue, correctExtraction }: ReviewQueueRouteOptions,
): void {
  app.get("/dashboard/review-queue", async (c) => {
    // task 5.7: the ONLY source of the broker id is c.var.brokerId, set by
    // session-auth.ts from the resolved session — never a query string,
    // path param, or body value. No other read of the request here.
    const rows = await needsReviewQueue(c.var.brokerId);

    // task 5.6: filtered defensively at THIS layer too, never trusting an
    // injected/real query implementation to have already filtered
    // correctly (spec "Rows with needs_review = false MUST NOT appear").
    const flagged = rows.filter((row) => row.needsReview);

    return c.json(
      {
        rows: flagged.map((row) => ({
          id: row.id,
          // design.md D-E: safeParse-backed, never throws — an
          // unrecognized shape degrades to { ok: false, raw } here rather
          // than crashing this endpoint (spec "An extraction shape the
          // stub does not recognize does not crash the endpoint").
          envelope: toEnvelope(row.output, row.confidence),
        })),
      },
      200,
    );
  });

  app.post("/dashboard/review-queue/:id/correction", async (c) => {
    const json = await c.req.json().catch(() => undefined);
    // task 5.11: a Zod failure (including a missing correctedOutput key)
    // returns 4xx WITHOUT calling correctExtraction at all — checked
    // BEFORE any write-function call below, never after.
    const parsed = correctionRequestSchema.safeParse(json);

    if (!parsed.success) {
      return c.json({ error: "invalid correction request body" }, 400);
    }

    // task 5.9, spec "correctedBy is taken from the session, not the
    // request body": `correctionRequestSchema` has no `correctedBy` field
    // at all (see that schema's own docstring — Zod strips it silently),
    // so there is no `parsed.data.correctedBy` to even consider reading.
    // The ONLY source of `correctedBy` is `c.var.session.brokerUserId`.
    const result = await correctExtraction({
      brokerId: c.var.brokerId,
      extractionId: c.req.param("id"),
      correctedOutput: parsed.data.correctedOutput,
      correctedBy: c.var.session.brokerUserId,
    });

    if (!result.found) {
      return c.json({ error: "extraction not found" }, 404);
    }

    return c.json({ ok: true }, 200);
  });
}
