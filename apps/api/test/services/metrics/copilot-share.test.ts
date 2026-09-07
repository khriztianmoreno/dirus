import { describe, expect, it } from "vitest";
import { copilotShare } from "../../../src/services/metrics/copilot-share.js";

/**
 * `admin-dashboard` (C1) task 6.1 (RED), design.md D-F, product-metrics
 * spec "Each metric has a distinct, callable endpoint" and "An endpoint
 * against an empty table returns a valid empty-state shape".
 *
 * `copilotShare` is `(tx: TenantDb) => Promise<MetricResult<...>>` per
 * design D-F — it never opens its own `withBrokerContext` (task 6.16's
 * reentrancy-guard note), so it is offline-testable with a FAKE `tx` whose
 * only surface this function touches is `tx.execute(sql...)` (the same
 * primitive `resolve-session.ts`/`consume-magic-link.ts` already use), never
 * a real Postgres connection. The live exact-delta proof (task 6.3) is a
 * separate file.
 */
function fakeTx(rows: Array<{ count: string | number }>) {
  return { execute: async () => ({ rows }) } as unknown as Parameters<typeof copilotShare>[0];
}

describe("copilotShare (task 6.1)", () => {
  it("given a fixture returning a count of copilot conversations, returns that count and empty: false", async () => {
    const tx = fakeTx([{ count: 3 }]);

    const result = await copilotShare(tx);

    expect(result.value.count).toBe(3);
    expect(result.sampleSize).toBe(3);
    expect(result.empty).toBe(false);
  });

  it("given zero conversations, returns empty: true and a well-formed MetricResult shape — never null, never an error", async () => {
    const tx = fakeTx([{ count: 0 }]);

    const result = await copilotShare(tx);

    expect(result).not.toBeNull();
    expect(result.value.count).toBe(0);
    expect(result.sampleSize).toBe(0);
    expect(result.empty).toBe(true);
  });

  it("carries H1's uninstrumented-denominator disclosure as a caveat, not hardcoded UI copy", async () => {
    const tx = fakeTx([{ count: 1 }]);

    const result = await copilotShare(tx);

    expect(typeof result.caveat).toBe("string");
    expect(result.caveat).toMatch(/denominator/i);
  });
});
