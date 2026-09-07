import { sql } from "drizzle-orm";
import { withBrokerContext } from "@dirus/db";

/**
 * `admin-dashboard` (C1) task 4.12, broker-auth spec "Logout Invalidates the
 * Session". This file is intentionally `@dirus/db`-importing, mirroring
 * `create-session.ts`/`consume-magic-link.ts`/`touch-session.ts`'s
 * convention — `routes/auth/logout.ts` takes a `RevokeSessionFn` injected
 * parameter instead of importing this as a value. Only
 * `apps/api/src/index.ts` wires in the real function below.
 *
 * A single-statement `UPDATE ... WHERE revoked_at IS NULL`, mirroring
 * `consume-magic-link.ts`'s atomic-UPDATE discipline: idempotent by
 * construction (a second logout call for an already-revoked session simply
 * matches zero rows), never a SELECT-then-UPDATE split.
 */
export type RevokeSessionParams = {
  brokerId: string;
  sessionTokenHash: string;
};

export type RevokeSessionFn = (params: RevokeSessionParams) => Promise<void>;

/** Real implementation (task 4.12), wired in only by `apps/api/src/index.ts`. */
export const revokeSession: RevokeSessionFn = async ({ brokerId, sessionTokenHash }) => {
  await withBrokerContext(brokerId, async (tx) => {
    await tx.execute(
      sql`update sessions
          set revoked_at = now()
          where session_token_hash = ${sessionTokenHash}
            and revoked_at is null`,
    );
  });
};
