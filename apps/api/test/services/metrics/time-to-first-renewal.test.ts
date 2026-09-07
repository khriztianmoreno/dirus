import { describe, expect, it } from "vitest";
import { timeToFirstRenewal } from "../../../src/services/metrics/time-to-first-renewal.js";

/**
 * `admin-dashboard` (C1) task 6.11 (RED), design.md D-F, product-metrics
 * spec §12 metric 5 ("Time-to-first-renewal-contact —
 * `messages.type = 'template'` + `brokers.created_at`"). Offline, mirrors
 * `copilot-share.test.ts`'s fake-`tx.execute` convention.
 */
function fakeTx(row: { created_at: string; first_template_at: string | null } | undefined) {
  return {
    execute: async () => ({ rows: row ? [row] : [] }),
  } as unknown as Parameters<typeof timeToFirstRenewal>[0];
}

describe("timeToFirstRenewal (task 6.11)", () => {
  it("given brokers.created_at and a first messages.type='template' timestamp, computes the correct date-diff", async () => {
    const tx = fakeTx({ created_at: "2027-01-01T00:00:00.000Z", first_template_at: "2027-01-06T00:00:00.000Z" });

    const result = await timeToFirstRenewal(tx);

    expect(result.value).toEqual({ days: 5 });
    expect(result.sampleSize).toBe(1);
    expect(result.empty).toBe(false);
  });

  it("given no template message sent yet, returns empty: true and a well-formed shape (never a fabricated day count)", async () => {
    const tx = fakeTx({ created_at: "2027-01-01T00:00:00.000Z", first_template_at: null });

    const result = await timeToFirstRenewal(tx);

    expect(result).not.toBeNull();
    expect(result.value).toBeNull();
    expect(result.sampleSize).toBe(0);
    expect(result.empty).toBe(true);
  });
});
