import { describe, expect, it } from "vitest";
import { needsReviewRate } from "../../../src/services/metrics/needs-review-rate.js";

/**
 * `admin-dashboard` (C1) task 6.7 (RED), design.md D-F, product-metrics
 * spec §12 metric 3 ("Extraction review load —
 * `extractions.needs_review` count/rate"). Offline, mirrors
 * `copilot-share.test.ts`'s fake-`tx.execute` convention.
 */
function fakeTx(row: { total: string | number; flagged: string | number }) {
  return { execute: async () => ({ rows: [row] }) } as unknown as Parameters<typeof needsReviewRate>[0];
}

describe("needsReviewRate (task 6.7)", () => {
  it("given a fixture with a mix of flagged/unflagged rows, returns the correct count/rate", async () => {
    const tx = fakeTx({ total: 10, flagged: 3 });

    const result = await needsReviewRate(tx);

    expect(result.value).toEqual({ flagged: 3, total: 10, rate: 0.3 });
    expect(result.sampleSize).toBe(10);
    expect(result.empty).toBe(false);
  });

  it("given an empty extractions table, returns empty: true and a well-formed shape", async () => {
    const tx = fakeTx({ total: 0, flagged: 0 });

    const result = await needsReviewRate(tx);

    expect(result).not.toBeNull();
    expect(result.value).toEqual({ flagged: 0, total: 0, rate: 0 });
    expect(result.sampleSize).toBe(0);
    expect(result.empty).toBe(true);
  });
});
