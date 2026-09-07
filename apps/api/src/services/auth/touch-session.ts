import { sql } from "drizzle-orm";
import { withBrokerContext } from "@dirus/db";

/**
 * `admin-dashboard` (C1) task 4.9, design.md D-B: the sliding-window
 * refresh — "refresh `idle_expires_at = now() + 7 days` at most once per
 * ~15 minutes of activity, not on literally every request — a write on
 * every GET turns a read-only dashboard into a write-heavy one for no
 * behavioural difference."
 *
 * This file is intentionally `@dirus/db`-importing, mirroring
 * `create-session.ts`'s and `consume-magic-link.ts`'s convention: only
 * `services/auth/resolve-session.ts` (task 4.12) calls this, strictly AFTER
 * its own `withBrokerContext` call (the one that validates the session row)
 * has already resolved — never nested inside it. Opening a SECOND,
 * independent `withBrokerContext` here is fine (it is not a nested/
 * reentrant call, just a second sequential one), per `tenant.ts`'s
 * reentrancy guard, which only rejects a call still in progress on the same
 * async context — the exact discipline `create-session.ts`'s own docstring
 * states for the identical "second sequential `withBrokerContext` call
 * after the first one committed" shape.
 *
 * **The throttle is a single atomic `UPDATE ... WHERE`**, not a
 * SELECT-then-conditionally-UPDATE — mirrors `consume-magic-link.ts`'s
 * atomic-UPDATE discipline (this project's own D-2/D-3 rule against
 * check-then-act races). The `WHERE last_seen_at < now() - interval '15
 * minutes'` clause is what makes the refresh self-throttling: most requests
 * (within the 15-minute window) match zero rows and perform no write at
 * all, at the database's own expense of re-evaluating the predicate — never
 * a first read-only round trip from this function to decide whether to
 * write.
 */
export type TouchSessionParams = {
  brokerId: string;
  sessionTokenHash: string;
};

export type TouchSessionFn = (params: TouchSessionParams) => Promise<void>;

/**
 * Real implementation (task 4.9), wired in only by
 * `services/auth/resolve-session.ts`. `'7 days'`/`'15 minutes'` are fixed
 * literals in the SQL text (design.md D-B's own stated values), not
 * interpolated parameters — nothing about them is caller-supplied.
 */
export const touchSession: TouchSessionFn = async ({ brokerId, sessionTokenHash }) => {
  await withBrokerContext(brokerId, async (tx) => {
    await tx.execute(
      sql`update sessions
          set idle_expires_at = now() + interval '7 days',
              last_seen_at = now()
          where session_token_hash = ${sessionTokenHash}
            and last_seen_at < now() - interval '15 minutes'`,
    );
  });
};
