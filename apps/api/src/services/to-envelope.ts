import { extractionEnvelope, type ExtractionEnvelope } from "@dirus/schemas";

/**
 * `admin-dashboard` (C1) tasks 5.3-5.5, design.md D-E. `extractions.output`
 * and `extractions.confidence` are two independently-typed `jsonb` columns
 * (`packages/db/src/schema/extractions.ts`) with zero real producers yet
 * (B2, `ingestion-agent`, does not exist). This is the ONE function that
 * zips them into `@dirus/schemas`'s `extractionEnvelope` read-side view —
 * see that schema's own `@provisional` docstring.
 *
 * `safeParse`, NEVER `parse` (design.md D-E, non-negotiable): an
 * unrecognized shape — non-overlapping keys, a non-numeric confidence, or
 * either column not even being a plain object — degrades to the
 * `{ ok: false, raw }` fallback marker rather than throwing. This is the
 * only honest behavior for a shape whose producer does not exist yet
 * (extraction-review spec "An extraction shape the stub does not recognize
 * does not crash the endpoint").
 */
export type ToEnvelopeResult =
  | { ok: true; fields: ExtractionEnvelope }
  | { ok: false; raw: { output: unknown; confidence: unknown } };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toEnvelope(output: unknown, confidence: unknown): ToEnvelopeResult {
  if (!isPlainRecord(output) || !isPlainRecord(confidence)) {
    return { ok: false, raw: { output, confidence } };
  }

  // Zip: for every field present in `output`, pair it with `confidence`'s
  // value at that same key (`undefined` if absent — `extractedField`'s
  // `confidence: z.number()` then rejects it via safeParse below, never a
  // guessed default).
  const zipped: Record<string, { value: unknown; confidence: unknown }> = {};
  for (const field of Object.keys(output)) {
    zipped[field] = { value: output[field], confidence: confidence[field] };
  }

  const parsed = extractionEnvelope.safeParse(zipped);
  if (!parsed.success) {
    return { ok: false, raw: { output, confidence } };
  }

  return { ok: true, fields: parsed.data };
}
