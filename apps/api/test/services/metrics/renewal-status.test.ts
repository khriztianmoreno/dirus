import { describe, expect, it } from "vitest";
import { renewalStatus } from "../../../src/services/metrics/renewal-status.js";

/**
 * `admin-dashboard` (C1) task 6.4 (RED), design.md D-F, product-metrics
 * spec §12 metric 2 ("Renewal funnel — `renewals GROUP BY status`").
 * Offline, mirrors `copilot-share.test.ts`'s fake-`tx.execute` convention.
 */
function fakeTx(rows: Array<{ status: string; count: string | number }>) {
  return { execute: async () => ({ rows }) } as unknown as Parameters<typeof renewalStatus>[0];
}

describe("renewalStatus (task 6.4)", () => {
  it("given a GROUP BY status fixture, returns correct per-status counts", async () => {
    const tx = fakeTx([
      { status: "paid", count: 4 },
      { status: "pending", count: 2 },
      { status: "escalated", count: 1 },
    ]);

    const result = await renewalStatus(tx);

    expect(result.value).toEqual({ paid: 4, pending: 2, escalated: 1 });
    expect(result.sampleSize).toBe(7);
    expect(result.empty).toBe(false);
  });

  it("given an empty table, returns empty: true and a well-formed shape", async () => {
    const tx = fakeTx([]);

    const result = await renewalStatus(tx);

    expect(result).not.toBeNull();
    expect(result.value).toEqual({});
    expect(result.sampleSize).toBe(0);
    expect(result.empty).toBe(true);
  });
});
