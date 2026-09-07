import { sql } from "drizzle-orm";
import type { TenantDb } from "@dirus/db";
import type { MetricResult } from "./types.js";

/**
 * `admin-dashboard` (C1) task 6.10, design.md D-F, product-metrics spec §12
 * metric 4 ("Conversation resolution snapshot — `conversations.status`
 * distribution, current-state") + Product Decisions P8/O8.
 *
 * `conversations.status` has no history table behind it (`conversations.ts`'s
 * `escalationReason` records only the LAST reason, not a transition log),
 * so this query — and this metric — can only ever report the CURRENT
 * distribution, never an at-close measurement. `snapshotType` carries that
 * disclosure as an explicit field on the return value (not folded into the
 * shared `caveat` string) so a consuming UI cannot render this panel
 * without seeing the marker: spec "The endpoint's response is marked as a
 * snapshot, not an at-close measurement". This is a deliberate, narrow
 * extension of `MetricResult<T>` for this one metric — `MetricResult<T>`
 * itself is unchanged (design.md D-F's shape), and no other metric in this
 * phase carries a `snapshotType` field.
 */
export type ConversationStatusSnapshotValue = Record<string, number>;

export type ConversationStatusSnapshotResult = MetricResult<ConversationStatusSnapshotValue> & {
  snapshotType: "current-state";
};

export async function conversationStatusSnapshot(tx: TenantDb): Promise<ConversationStatusSnapshotResult> {
  const result = await tx.execute<{ status: string; count: number | string }>(
    sql`select status, count(*)::int as count from conversations group by status`,
  );

  const value: ConversationStatusSnapshotValue = {};
  let total = 0;
  for (const row of result.rows) {
    const count = Number(row.count);
    value[row.status] = count;
    total += count;
  }

  return {
    value,
    sampleSize: total,
    empty: total === 0,
    // P8/O8: a row that was escalated and later resolved is indistinguishable
    // from one that never involved a human — there is no transition-history
    // table to tell them apart, only this current-state distribution.
    caveat:
      "P8/O8: current-state snapshot only — a conversation escalated then later resolved is indistinguishable from one that never involved a human.",
    snapshotType: "current-state",
  };
}
