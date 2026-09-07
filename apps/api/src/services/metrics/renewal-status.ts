import { sql } from "drizzle-orm";
import type { TenantDb } from "@dirus/db";
import type { MetricResult } from "./types.js";

/**
 * `admin-dashboard` (C1) task 6.5, design.md D-F, product-metrics spec §12
 * metric 2 ("Renewal funnel — `renewals GROUP BY status`"). Same
 * `(tx: TenantDb) => Promise<MetricResult<T>>` shape as `copilot-share.ts` —
 * see that file's docstring for the reentrancy-guard reasoning, identical
 * here.
 */
export type RenewalStatusValue = Record<string, number>;

export async function renewalStatus(tx: TenantDb): Promise<MetricResult<RenewalStatusValue>> {
  const result = await tx.execute<{ status: string; count: number | string }>(
    sql`select status, count(*)::int as count from renewals group by status`,
  );

  const value: RenewalStatusValue = {};
  let total = 0;
  for (const row of result.rows) {
    const count = Number(row.count);
    value[row.status] = count;
    total += count;
  }

  return { value, sampleSize: total, empty: total === 0 };
}
