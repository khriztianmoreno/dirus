import { sql } from "drizzle-orm";
import { withBrokerContext } from "@dirus/db";

/**
 * `admin-dashboard` (C1) task 3.15, design.md D-A's stated invariant ("the
 * resolver functions decide nothing") and data-flow diagram. This file is
 * intentionally `@dirus/db`-importing — `routes/auth/callback.ts` takes a
 * `ConsumeMagicLinkTokenFn` injected parameter instead of importing this
 * as a value, mirroring `import-policies-writer.ts`'s convention. Only
 * `apps/api/src/index.ts` wires in the real function below.
 *
 * **The atomic UPDATE is the whole point**: single-use (`used_at IS NULL`)
 * and expiry (`expires_at > now()`) are both checked in the SAME UPDATE
 * statement's WHERE clause, inside `withBrokerContext` — never split into
 * a separate SELECT-then-UPDATE, which would reopen a race between two
 * simultaneous presentations of the same token (this project's own
 * established D-2/D-3 discipline against check-then-act races). Whichever
 * of two concurrent callers' UPDATE statements the database serializes
 * first wins the row; the other necessarily sees zero rows returned,
 * because the row's `used_at` is no longer `NULL` by the time its own
 * UPDATE's WHERE clause evaluates it.
 */
export type ConsumeMagicLinkParams = {
  brokerId: string;
  tokenHash: string;
};

export type ConsumeMagicLinkResult = { ok: true; brokerUserId: string } | { ok: false };

export type ConsumeMagicLinkTokenFn = (params: ConsumeMagicLinkParams) => Promise<ConsumeMagicLinkResult>;

/** Real implementation (task 3.15), wired in only by `apps/api/src/index.ts`. */
export const consumeMagicLinkToken: ConsumeMagicLinkTokenFn = async ({ brokerId, tokenHash }) => {
  return withBrokerContext(brokerId, async (tx) => {
    const result = await tx.execute<{ broker_user_id: string }>(
      sql`update magic_link_tokens
          set used_at = now()
          where token_hash = ${tokenHash} and used_at is null and expires_at > now()
          returning broker_user_id`,
    );

    const row = result.rows[0];
    if (!row) {
      return { ok: false };
    }

    return { ok: true, brokerUserId: row.broker_user_id };
  });
};
