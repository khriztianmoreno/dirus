import { sql } from "drizzle-orm";
import type { TenantDb } from "@dirus/db";
import type { MetricResult } from "./types.js";

const MS_PER_DAY = 86_400_000;

/**
 * `admin-dashboard` (C1) task 6.12, design.md D-F, product-metrics spec §12
 * metric 5 ("Time-to-first-renewal-contact — `messages.type = 'template'`
 * + `brokers.created_at`"). Same `(tx: TenantDb) => Promise<MetricResult<T>>`
 * shape as `copilot-share.ts` — see that file's docstring for the
 * reentrancy-guard reasoning, identical here.
 *
 * RLS scopes `brokers` to exactly the caller's own broker row (one row),
 * so `select b.created_at from brokers b` never needs an explicit
 * `WHERE id = ...`. The subquery finds the EARLIEST `messages.type =
 * 'template'` row across that broker's conversations — the first HSM
 * (renewal-contact) template message ever sent — or `null` if none has
 * been sent yet.
 */
export type TimeToFirstRenewalValue = { days: number };

export async function timeToFirstRenewal(tx: TenantDb): Promise<MetricResult<TimeToFirstRenewalValue | null>> {
  const result = await tx.execute<{ created_at: string; first_template_at: string | null }>(
    sql`select b.created_at as created_at,
               (select min(m.created_at)
                from messages m
                join conversations c on c.id = m.conversation_id
                where m.type = 'template') as first_template_at
        from brokers b`,
  );

  const row = result.rows[0];

  if (!row || row.first_template_at === null) {
    // No template message has been sent yet — never fabricate a day count
    // from a missing endpoint.
    return { value: null, sampleSize: 0, empty: true };
  }

  const days = Math.floor(
    (new Date(row.first_template_at).getTime() - new Date(row.created_at).getTime()) / MS_PER_DAY,
  );

  return { value: { days }, sampleSize: 1, empty: false };
}
