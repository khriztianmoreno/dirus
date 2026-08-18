import { AsyncLocalStorage } from "node:async_hooks";
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

// Matches gen_random_uuid()/v4 only (version nibble [1-5], variant [89ab]) —
// this rejects UUID v6/v7/v8 and the nil UUID, all of which Postgres's
// `uuid` type otherwise accepts. If Phase 3 changes the ID generation
// strategy (e.g. to v7 for index locality), this regex MUST be updated or
// every broker id will be rejected.
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

// Tracks whether the current async context is already inside a
// `withBrokerContext` call. Needed because `withBrokerContext` always calls
// the module-level `db.transaction(...)`, never the current `tx` — under
// `drizzle-orm/node-postgres`, when the client is a `Pool` this checks out a
// SECOND physical connection and opens an independent transaction. A nested
// call (e.g. a shared helper that always wraps its DB access in
// `withBrokerContext`, unaware it is already inside one) would therefore
// produce two unrelated transactions: an outer rollback would not undo the
// inner commit, and it can deadlock a small or exhausted pool.
//
// We deliberately THROW on reentrancy rather than silently reusing the
// outer transaction. Silently reusing it would be plausible-looking but
// wrong: it would mask a broker-id mismatch if the nested call requested a
// DIFFERENT brokerId than the outer one, silently running the nested `fn`
// under the wrong tenant context.
//
// LIMITATION — false positives on fire-and-forget work: this guard tracks
// ASYNC-RESOURCE LINEAGE (via AsyncLocalStorage), not the transaction's
// commit boundary. If `fn` spawns async work that is not awaited before
// `withBrokerContext` returns (e.g. `setTimeout(() => withBrokerContext(...))`
// scheduled from inside the callback, or an un-awaited `.then()` chain), that
// work still runs with the outer context attached — `getStore()` is truthy
// for it — even though the outer transaction has already committed by the
// time it runs. Such a call will be wrongly rejected as reentrant. This is
// NOT a bug in the outer transaction's correctness, only in this guard's
// ability to tell "still inside the callback" apart from "spawned by the
// callback, running later". The fix is at the call site, not here: spawn
// such background work AFTER `withBrokerContext` resolves, never from inside
// its callback.
const inBrokerContext = new AsyncLocalStorage<true>();

/**
 * Opens a transaction, scopes `app.broker_id` to that transaction only via
 * `set_config(..., true)` — the parameterized equivalent of `SET LOCAL`,
 * chosen because `SET LOCAL` takes no bind parameters (design.md D-C) —
 * runs `fn` against the scoped transaction client, and commits or rolls
 * back atomically. The setting is discarded with the transaction, so two
 * sequential calls on the same pooled connection never leak into each
 * other (data-model spec: "Helper scopes broker_id to the transaction
 * only").
 *
 * Throws if called reentrantly (i.e. from within another `withBrokerContext`
 * call already in progress on the current async context) — see
 * `inBrokerContext` above for why. Callers already inside a
 * `withBrokerContext` block must pass the existing `tx` down to shared
 * helpers instead of calling `withBrokerContext` again.
 *
 * NOTE: this check is based on async-resource lineage, not the transaction's
 * commit boundary — see the limitation documented on `inBrokerContext` above.
 * Fire-and-forget work spawned inside `fn` but not awaited before `fn`
 * returns will inherit the context and can be wrongly rejected here.
 */
export async function withBrokerContext<T>(
  brokerId: string,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  assertUuid(brokerId);

  if (inBrokerContext.getStore()) {
    throw new Error(
      "withBrokerContext() was called reentrantly — a call is already in progress on " +
        "this async context. Nested calls are forbidden: each call opens a NEW physical " +
        "connection and transaction (via db.transaction()), so a nested call would run in " +
        "an unrelated transaction that an outer rollback cannot undo, and can deadlock a " +
        "small/exhausted pool. Pass the existing `tx` down to the nested helper instead of " +
        "calling withBrokerContext() again. If you did NOT call withBrokerContext() from " +
        "inside another call's callback, this may be a false positive: this guard tracks " +
        "async-resource lineage, not commit boundaries, so fire-and-forget work spawned " +
        "(and not awaited) inside a withBrokerContext callback — e.g. a background " +
        "setTimeout or un-awaited .then() — inherits that context and is rejected even " +
        "after the outer transaction has committed. Spawn such work AFTER the outer " +
        "withBrokerContext() call resolves instead.",
    );
  }

  return inBrokerContext.run(true, () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.broker_id', ${brokerId}, true)`);
      return fn(tx as TenantDb);
    }),
  );
}
