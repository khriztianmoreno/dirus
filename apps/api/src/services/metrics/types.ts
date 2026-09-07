/**
 * `admin-dashboard` (C1) Phase 6, design.md D-F: the ONE shared shape every
 * metric function returns. This is the only thing the six metrics share —
 * D-F explicitly rejects a shared "metrics engine"/query-builder
 * abstraction on top of this (see that section's Option table): three
 * tables, two `GROUP BY`s, one date-diff, and one that isn't SQL at all
 * (Langfuse HTTP) share no common query shape, only this common RESULT
 * shape.
 */
export type MetricResult<T> = {
  value: T;
  /**
   * The number of underlying rows the value was computed from. `0` here
   * and `empty: true` together are what make an intentional "no data yet"
   * state distinguishable from a legitimate zero count computed from real
   * (non-empty) data — spec "Metrics Return Correct Empty-State Results".
   */
  sampleSize: number;
  /** `sampleSize === 0`, kept as an explicit field rather than derived at every call site so a caller never has to remember the equivalence. */
  empty: boolean;
  /**
   * Travels as DATA from the query/function itself, never as copy
   * hardcoded in a UI component (design.md D-F) — e.g. H1's
   * uninstrumented-denominator disclosure, or P8/O8's current-state-
   * snapshot disclosure, so the caveat cannot silently drift away from the
   * query that requires it.
   */
  caveat?: string;
};
