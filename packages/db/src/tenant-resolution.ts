import { sql } from "drizzle-orm";
import { db } from "./internal/client.js";

// int4 bounds for `chatwoot_account_id` (Postgres `integer`) — see design.md
// D-E. `MAX_KEY_LENGTH` (a string-length cap) is deleted outright, not
// adapted: an integer-range check is a strictly stronger validation than a
// length cap, so nothing is lost (fix-chatwoot-tenant-resolution proposal P2).
const MIN_ACCOUNT_ID = 1;
const MAX_ACCOUNT_ID = 2_147_483_647; // int4 upper bound — chatwoot_account_id is `integer`

/**
 * Resolves a Chatwoot `account.id` to the owning broker's `id` (design.md
 * D-E, fix-chatwoot-tenant-resolution/F2.1), by calling the
 * `dirus_resolve_broker_id` SECURITY DEFINER function installed by
 * migration `0007_chatwoot_account_resolution.sql` (design.md D-C/D-D),
 * which superseded `0004_tenant_resolver.sql`'s `(text)` signature.
 *
 * This is a single statement on the pooled client, run OUTSIDE any
 * transaction and OUTSIDE `withBrokerContext` — there is no tenant context
 * to scope yet, because learning the tenant is the whole point of this
 * call. It returns an opaque `uuid` string or `null` (unknown key). It
 * never returns a row, a broker column other than `id`, or any table
 * handle — see `src/tenant.ts`'s `TenantDb` docstring and `src/index.ts`'s
 * barrel docstring for why that boundary is deliberate and must not be
 * widened.
 *
 * The integer-range guard below is a package-boundary precondition, not a
 * duplicate of the request-pipeline guard `extractResolutionKey()`
 * (`@dirus/schemas`) already enforces before a resolution key ever reaches
 * this function (design.md D-B, "the redundancy question, answered
 * explicitly"): a package's public export validates its own preconditions,
 * a request pipeline validates the request. This guard is therefore
 * unreachable through the webhook path today, and is kept anyway for any
 * other importer (a backfill script, an admin path) that has not gone
 * through that pipeline's own refusal.
 */
export async function resolveBrokerIdByChatwootAccountId(accountId: number): Promise<string | null> {
  if (!Number.isInteger(accountId) || accountId < MIN_ACCOUNT_ID || accountId > MAX_ACCOUNT_ID) {
    throw new Error(
      `chatwoot_account_id must be an integer in [${MIN_ACCOUNT_ID}, ${MAX_ACCOUNT_ID}] ` +
        `(received ${accountId}). Refusing to query.`,
    );
  }

  const result = await db.execute<{ dirus_resolve_broker_id: string | null }>(
    sql`select public.dirus_resolve_broker_id(${accountId})`,
  );

  return result.rows[0]?.dirus_resolve_broker_id ?? null;
}
