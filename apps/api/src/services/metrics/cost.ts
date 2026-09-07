import type { MetricResult } from "./types.js";

/**
 * `admin-dashboard` (C1) task 6.14, design.md D-F, product-metrics spec §12
 * metric 6 ("Cost per conversation/renewal — Langfuse-sourced"). Isolated
 * behind this interface and droppable without touching the other five
 * (proposal P6): this metric alone accepts a nullable dependency rather
 * than the `(tx: TenantDb) => ...` shape every other metric in this phase
 * uses, because it is "not even SQL at all" (design.md D-F) — Langfuse
 * cost data comes from an HTTP API, not this codebase's own tables.
 *
 * **Implemented, not deferred as a task** — `costMetric` itself is fully
 * built and tested (task 6.13/6.14 both GREEN). What IS deferred is the
 * real Langfuse HTTP client (`packages/integrations/src/langfuse/*.ts`,
 * design.md's File Changes table) — that client is not built in this
 * phase's task list (tasks 6.1-6.17 name only `cost.ts` behind this
 * interface, never a Langfuse package build), so `apps/api/src/index.ts`
 * wires this metric with `langfuseCostSource: null` for now, which is
 * exactly the "no Langfuse client configured" production state the spec's
 * own scenario describes. Building the real client is future,
 * out-of-phase work — not a gap in this phase's own scope.
 */
export type LangfuseCostValue = { costPerConversation: number; costPerRenewal: number };

export type LangfuseCostSource = {
  fetchCost: () => Promise<{ available: true; value: LangfuseCostValue } | { available: false }>;
};

export type CostMetricResult = MetricResult<LangfuseCostValue | null> & {
  status: "ok" | "deferred";
};

/**
 * `source === null` (no Langfuse client configured at all) and a
 * configured source reporting `available: false` are handled identically —
 * both are "the data is not available right now", and this function's job
 * is only to disclose that, never to fabricate a numeric value or a bare
 * `0` in its place (spec "Cost Metric Discloses Deferred State").
 */
export async function costMetric(source: LangfuseCostSource | null): Promise<CostMetricResult> {
  if (source === null) {
    return { value: null, sampleSize: 0, empty: true, status: "deferred" };
  }

  const result = await source.fetchCost();

  if (!result.available) {
    return { value: null, sampleSize: 0, empty: true, status: "deferred" };
  }

  return { value: result.value, sampleSize: 1, empty: false, status: "ok" };
}
