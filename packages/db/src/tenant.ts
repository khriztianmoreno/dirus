import { sql } from "drizzle-orm";
import { db } from "./internal/client.js";

/**
 * The only tenant-scoped handle callers ever receive (design.md D-C). It is
 * the Drizzle transaction client `db.transaction()` hands to its callback —
 * not the raw pooled `db` — so everything issued through it runs inside the
 * transaction opened by `withBrokerContext`. Derived directly from `db`'s
 * own type so it always matches what `db.transaction` actually produces.
 */
export type TenantDb = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Rejects anything that is not a well-formed UUID (design.md D-E). This runs
 * BEFORE the value is ever interpolated into `set_config`, so a malformed
 * `brokerId` never reaches SQL — never as a belt against injection, never as
 * a way to accidentally set `app.broker_id` to an empty string.
 */
export function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Expected a well-formed UUID for brokerId, received: ${JSON.stringify(value)}`);
  }
}

/**
 * Opens a transaction, scopes `app.broker_id` to that transaction only via
 * `set_config(..., true)` — the parameterized equivalent of `SET LOCAL`,
 * chosen because `SET LOCAL` takes no bind parameters (design.md D-C) —
 * runs `fn` against the scoped transaction client, and commits or rolls
 * back atomically. The setting is discarded with the transaction, so two
 * sequential calls on the same pooled connection never leak into each
 * other (data-model spec: "Helper scopes broker_id to the transaction
 * only").
 */
export async function withBrokerContext<T>(
  brokerId: string,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  assertUuid(brokerId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.broker_id', ${brokerId}, true)`);
    return fn(tx as TenantDb);
  });
}
