import { z } from "zod";

/**
 * `admin-dashboard` (C1) task 5.2, design.md D-E: **the envelope stub is a
 * joined VIEW of two columns, not a description of either column.**
 * `extractions.output` and `extractions.confidence` are two independently-
 * typed `jsonb` columns (`packages/db/src/schema/extractions.ts`) — no
 * producer emits this merged `Record<field, { value, confidence }>` shape,
 * and none is likely to soon. `apps/api/src/services/to-envelope.ts`'s
 * `toEnvelope(output, confidence)` is the ONE place that zips the two
 * columns into this shape for read-side rendering.
 *
 * @provisional — owned by B2 (`ingestion-agent`) on arrival. C1 only READS
 * this. Design.md D-E states plainly: "this schema will very likely need
 * revision when B2 lands." That is an expected spec delta, not a defect.
 *
 * **Loose on `value`, strict on `confidence`.** `confidence` is the only
 * member the review queue *reasons* about — it drives the 0.85 threshold
 * and the per-field highlight — so it is required, numeric, and bounded.
 * `value` is only rendered, so `unknown` costs nothing and avoids guessing
 * at field types `caratula.ts`/`cedula.ts`/`tarjeta-propiedad.ts` already
 * model separately.
 */
export const extractedField = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
});

export const extractionEnvelope = z.record(z.string(), extractedField);

export type ExtractedField = z.infer<typeof extractedField>;
export type ExtractionEnvelope = z.infer<typeof extractionEnvelope>;
