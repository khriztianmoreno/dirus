import type { Hono } from "hono";
import type { AppVariables } from "../../app.js";
import type { MetricResult } from "../../services/metrics/types.js";
import type { ConversationStatusSnapshotResult } from "../../services/metrics/conversation-status-snapshot.js";
import type { CostMetricResult } from "../../services/metrics/cost.js";
import type { NeedsReviewRateValue } from "../../services/metrics/needs-review-rate.js";
import type { RenewalStatusValue } from "../../services/metrics/renewal-status.js";
import type { TimeToFirstRenewalValue } from "../../services/metrics/time-to-first-renewal.js";

/**
 * `admin-dashboard` (C1) tasks 6.15-6.16, design.md D-F, product-metrics
 * spec (all requirements). One `GET` endpoint per §12 metric, colocated in
 * one file per design.md's Files table (`apps/api/src/routes/dashboard/
 * {review-queue,metrics}.ts`).
 *
 * Mounted BEHIND `session-auth.ts` + `csrf-guard.ts` in `app.ts`, exactly
 * like `review-queue.ts` — this route itself never authenticates anything;
 * it only reads `c.var.brokerId`.
 *
 * **Task 6.16's reentrancy shape, and why it differs from every other
 * route in this codebase**: every OTHER injected function in this codebase
 * (`needsReviewQueue`, `correctExtraction`, `importPolicyRows`, ...) has
 * the shape `(...) => Promise<T>` and opens its OWN `withBrokerContext`
 * internally (see `needs-review-queue.ts`). The six functions below have
 * that SAME external shape — `(brokerId: string) => Promise<MetricResult<T>>`
 * — from this route's point of view, so this file's own code is
 * indistinguishable from `review-queue.ts`'s pattern and needs no special
 * casing here. What IS different, per design.md D-F ("every one runs
 * inside the caller's `withBrokerContext`, never opening its own"), is
 * INSIDE each function: `apps/api/src/services/metrics/*.ts`'s exported
 * functions are `(tx: TenantDb) => Promise<MetricResult<T>>` — they never
 * call `withBrokerContext` themselves. `apps/api/src/index.ts` is the
 * actual "caller" D-F refers to: it wires each metric into THIS route's
 * `(brokerId) => Promise<T>` shape with a one-line partial application,
 * `(brokerId) => withBrokerContext(brokerId, copilotShare)` — literally
 * `withBrokerContext`'s own `fn` parameter, applied directly, because
 * `copilotShare`'s signature already matches it exactly. That keeps this
 * route file itself free of any `@dirus/db` import (offline-testable,
 * mirrors `review-queue.ts`'s own discipline) while still satisfying D-F's
 * "the metric function never opens its own" reentrancy rule.
 */
export type MetricFn<T> = (brokerId: string) => Promise<T>;

export type CopilotShareResult = MetricResult<{ count: number }>;
export type NeedsReviewRateResult = MetricResult<NeedsReviewRateValue>;
export type RenewalStatusResult = MetricResult<RenewalStatusValue>;
export type TimeToFirstRenewalResult = MetricResult<TimeToFirstRenewalValue | null>;

export type MetricsRouteOptions = {
  copilotShare: MetricFn<CopilotShareResult>;
  renewalStatus: MetricFn<RenewalStatusResult>;
  needsReviewRate: MetricFn<NeedsReviewRateResult>;
  conversationStatusSnapshot: MetricFn<ConversationStatusSnapshotResult>;
  timeToFirstRenewal: MetricFn<TimeToFirstRenewalResult>;
  cost: MetricFn<CostMetricResult>;
};

export function registerMetricsRoute(
  app: Hono<{ Variables: AppVariables }>,
  {
    copilotShare,
    renewalStatus,
    needsReviewRate,
    conversationStatusSnapshot,
    timeToFirstRenewal,
    cost,
  }: MetricsRouteOptions,
): void {
  // task 6.15: the ONLY source of the broker id in every one of the six
  // handlers below is c.var.brokerId, set by session-auth.ts from the
  // resolved session — never a query string, path param, or body value.
  // No route below defines or parses a `brokerId` input field at all.
  app.get("/dashboard/metrics/copilot-share", async (c) => {
    const result = await copilotShare(c.var.brokerId);
    return c.json(result, 200);
  });

  app.get("/dashboard/metrics/renewal-status", async (c) => {
    const result = await renewalStatus(c.var.brokerId);
    return c.json(result, 200);
  });

  app.get("/dashboard/metrics/needs-review-rate", async (c) => {
    const result = await needsReviewRate(c.var.brokerId);
    return c.json(result, 200);
  });

  app.get("/dashboard/metrics/conversation-status-snapshot", async (c) => {
    const result = await conversationStatusSnapshot(c.var.brokerId);
    return c.json(result, 200);
  });

  app.get("/dashboard/metrics/time-to-first-renewal", async (c) => {
    const result = await timeToFirstRenewal(c.var.brokerId);
    return c.json(result, 200);
  });

  app.get("/dashboard/metrics/cost", async (c) => {
    const result = await cost(c.var.brokerId);
    return c.json(result, 200);
  });
}
