/**
 * `admin-dashboard` (C1) Phase 7 — response shapes for the endpoints this
 * SPA consumes, mirrored from `apps/api/src`'s own route/service types
 * (`middleware/session-auth.ts`'s `ResolvedSession`,
 * `services/to-envelope.ts`'s `ToEnvelopeResult`,
 * `services/metrics/*.ts`). Kept as plain, hand-mirrored types here rather
 * than importing `@dirus/api` — `apps/api` is a server app, not a shared
 * package, and no app may import another app
 * (`.dependency-cruiser.cjs`: "no app may import another app").
 */

/** `GET /api/auth/me` (task 7.4) — the minimal fields `RequireSession` needs. */
export type MeResponse = {
  brokerId: string;
  brokerUserId: string;
  role: string;
};

/** Mirrors `@dirus/schemas`'s `ExtractedField`/`ExtractionEnvelope`. */
export type ExtractedField = {
  value: unknown;
  confidence: number;
};

export type ExtractionEnvelope = Record<string, ExtractedField>;

/** Mirrors `apps/api/src/services/to-envelope.ts`'s `ToEnvelopeResult`. */
export type ToEnvelopeResult =
  | { ok: true; fields: ExtractionEnvelope }
  | { ok: false; raw: { output: unknown; confidence: unknown } };

export type ReviewQueueRow = {
  id: string;
  envelope: ToEnvelopeResult;
};

export type ReviewQueueResponse = {
  rows: ReviewQueueRow[];
};

export type CorrectionRequest = {
  correctedOutput: Record<string, unknown>;
};

/** Mirrors `apps/api/src/services/metrics/types.ts`'s `MetricResult<T>`. */
export type MetricResult<T> = {
  value: T;
  sampleSize: number;
  empty: boolean;
  caveat?: string;
};

export type ConversationStatusSnapshotResult = MetricResult<Record<string, number>> & {
  /** design.md P8/O8 — this metric is a current-state snapshot, never the §12 at-close metric. */
  snapshotType: "current-state";
};

export type CostMetricResult = MetricResult<{ costPerConversation: number; costPerRenewal: number } | null> & {
  status: "ok" | "deferred";
};

export type NeedsReviewRateValue = { flagged: number; total: number; rate: number };
export type RenewalStatusValue = Record<string, number>;
export type TimeToFirstRenewalValue = { days: number };
