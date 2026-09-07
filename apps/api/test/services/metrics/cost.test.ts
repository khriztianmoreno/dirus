import { describe, expect, it } from "vitest";
import { costMetric, type LangfuseCostSource } from "../../../src/services/metrics/cost.js";

/**
 * `admin-dashboard` (C1) task 6.13 (RED), design.md D-F, product-metrics
 * spec "Cost Metric Discloses Deferred State" — with no Langfuse client
 * configured (a `null` source, or a fake `LangfuseCostSource` reporting
 * `available: false`), the metric returns an explicit `status: "deferred"`
 * marker, never a fabricated numeric value, never a bare `0` that could be
 * mistaken for a real measurement.
 */
describe("costMetric (task 6.13)", () => {
  it("with no Langfuse client configured (null source), returns status: 'deferred' — never a fabricated number", async () => {
    const result = await costMetric(null);

    expect(result.status).toBe("deferred");
    expect(result.value).toBeNull();
    // Explicitly NOT a bare 0 mistaken for a real zero-cost measurement.
    expect(result.value).not.toBe(0);
    expect(result.empty).toBe(true);
  });

  it("with a fake LangfuseCostSource reporting unavailable, also returns status: 'deferred'", async () => {
    const source: LangfuseCostSource = {
      fetchCost: async () => ({ available: false }),
    };

    const result = await costMetric(source);

    expect(result.status).toBe("deferred");
    expect(result.value).toBeNull();
  });

  it("with a fake LangfuseCostSource reporting real data, returns status: 'ok' with the computed value", async () => {
    const source: LangfuseCostSource = {
      fetchCost: async () => ({
        available: true,
        value: { costPerConversation: 0.42, costPerRenewal: 1.15 },
      }),
    };

    const result = await costMetric(source);

    expect(result.status).toBe("ok");
    expect(result.value).toEqual({ costPerConversation: 0.42, costPerRenewal: 1.15 });
    expect(result.empty).toBe(false);
  });
});
