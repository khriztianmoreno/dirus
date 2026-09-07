import { describe, expect, it } from "vitest";
import { conversationStatusSnapshot } from "../../../src/services/metrics/conversation-status-snapshot.js";

/**
 * `admin-dashboard` (C1) task 6.9 (RED), design.md D-F, product-metrics
 * spec "The endpoint's response is marked as a snapshot, not an at-close
 * measurement" and "A conversation escalated then later closed is
 * indistinguishable from one that never involved a human" — Product
 * Decisions P8/O8. Offline, mirrors `copilot-share.test.ts`'s
 * fake-`tx.execute` convention.
 *
 * `conversationStatusSnapshot` computes from `conversations.status`'s
 * CURRENT value only (no transition-history table exists — see
 * `conversations.ts`'s `escalationReason` column, which records the LAST
 * reason, not a history of every transition). This test's own fake `tx`
 * therefore returns a `GROUP BY status` shape identical to what a real
 * query sees for two rows that both currently sit at `status = 'resolved'`
 * — one previously escalated, one never — because from `status`'s own
 * current-value perspective those two rows are the SAME row shape. That is
 * the whole point of the adversarial case below: the query has no
 * `escalation_reason`/history column to even read to tell them apart, so
 * the fixture never carries one.
 */
function fakeTx(rows: Array<{ status: string; count: string | number }>) {
  return {
    execute: async () => ({ rows }),
  } as unknown as Parameters<typeof conversationStatusSnapshot>[0];
}

describe("conversationStatusSnapshot (task 6.9)", () => {
  it("marks the response with an explicit current-state snapshot field, distinct from an at-close measurement", async () => {
    const tx = fakeTx([{ status: "resolved", count: 2 }]);

    const result = await conversationStatusSnapshot(tx);

    expect(result.snapshotType).toBe("current-state");
  });

  it(
    "adversarial: two rows both currently status='resolved' — one previously escalated, one never — " +
      "are counted identically under 'resolved', with no field claiming to distinguish them",
    async () => {
      // The fixture models the fact stated in the docstring above: a
      // `GROUP BY status` query cannot see PAST escalation state, only
      // CURRENT status, so both rows collapse into the same `resolved`
      // bucket with count 2 — there is no separate "resolved after
      // escalation" bucket for the query to even produce.
      const tx = fakeTx([{ status: "resolved", count: 2 }]);

      const result = await conversationStatusSnapshot(tx);

      expect(result.value).toEqual({ resolved: 2 });
      expect(result.value).not.toHaveProperty("resolved_after_escalation");
      expect(result.value).not.toHaveProperty("resolved_without_human");
    },
  );

  it("given an empty conversations table, returns empty: true", async () => {
    const tx = fakeTx([]);

    const result = await conversationStatusSnapshot(tx);

    expect(result.value).toEqual({});
    expect(result.sampleSize).toBe(0);
    expect(result.empty).toBe(true);
    expect(result.snapshotType).toBe("current-state");
  });
});
