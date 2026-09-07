import { sql } from "drizzle-orm";
import { resolveBrokerIdBySessionTokenHash, withBrokerContext } from "@dirus/db";
import type { ResolvedSession, ResolveSession } from "../../middleware/session-auth.js";
import { touchSession } from "./touch-session.js";

/**
 * `admin-dashboard` (C1) task 4.12, design.md D-A/D-D. This is the real
 * `ResolveSession` implementation wired into `session-auth.ts` — only
 * `apps/api/src/index.ts` imports it as a value, mirroring
 * `create-session.ts`/`consume-magic-link.ts`'s convention.
 *
 * **Where the `revoked_at IS NULL` check actually lives (task 4.12's design
 * gap, resolved here explicitly rather than guessed).** Design.md D-A
 * states the `SECURITY DEFINER` resolver functions "decide nothing" — they
 * filter ONLY on the key, never `expires_at`/`used_at`/`revoked_at" — and
 * that invariant is a migration-level contract this phase does not own or
 * modify. `resolveBrokerIdBySessionTokenHash` (`@dirus/db`,
 * `packages/db/src/auth-resolution.ts`) therefore returns a bare
 * `broker_id` for ANY session row matching the hash, revoked or not, idle
 * or not — exactly like `resolveBrokerIdByMagicLinkTokenHash` does for a
 * used/expired token. Following the SAME pattern `consume-magic-link.ts`
 * established for that resolver (task 3.15): the bare-uuid resolver's job
 * is only to learn WHICH broker's `withBrokerContext` to open; the actual
 * validity predicate — `revoked_at IS NULL AND idle_expires_at > now()` —
 * is evaluated here, in application code, reading the full session row
 * (joined with `broker_users` for `role`) under RLS, in the SAME
 * transaction. This keeps D-A's invariant intact (the resolver function
 * itself never gains a `revoked_at` predicate, which would need a migration
 * change this phase does not own) and mirrors the established
 * resolve-bare-uuid-then-validate-under-RLS shape exactly.
 *
 * **Ordering, and why `touchSession` is a SECOND sequential
 * `withBrokerContext` call, never nested inside this one:** the validating
 * SELECT below runs inside its own `withBrokerContext(brokerId, ...)` call.
 * Once that call has resolved (committed/returned), `touchSession` opens
 * its OWN independent `withBrokerContext` call — never inside the first
 * one's callback — mirroring `create-session.ts`'s documented reasoning for
 * the identical shape: `tenant.ts`'s reentrancy guard (`inBrokerContext`,
 * an `AsyncLocalStorage`) tracks async-resource LINEAGE, not a transaction
 * boundary, so nesting a second call inside the first callback would be
 * wrongly rejected as reentrant.
 */
type SessionRow = {
  broker_user_id: string;
  csrf_token_hash: string;
  role: string;
};

export const resolveSession: ResolveSession = async (sessionTokenHash: string): Promise<ResolvedSession | null> => {
  const brokerId = await resolveBrokerIdBySessionTokenHash(sessionTokenHash);
  if (brokerId === null) {
    return null;
  }

  const row = await withBrokerContext(brokerId, async (tx) => {
    const result = await tx.execute<SessionRow>(
      sql`select s.broker_user_id, s.csrf_token_hash, bu.role
          from sessions s
          join broker_users bu on bu.id = s.broker_user_id
          where s.session_token_hash = ${sessionTokenHash}
            and s.revoked_at is null
            and s.idle_expires_at > now()`,
    );
    return result.rows[0] ?? null;
  });

  if (row === null) {
    return null;
  }

  // Sequential, not nested — see docstring above.
  await touchSession({ brokerId, sessionTokenHash });

  return {
    brokerId,
    brokerUserId: row.broker_user_id,
    role: row.role,
    csrfTokenHash: row.csrf_token_hash,
  };
};
