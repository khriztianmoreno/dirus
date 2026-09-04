import { sql } from "drizzle-orm";
import { db } from "./internal/client.js";

/**
 * The maximum length accepted for the `wa_phone_number_id` lookup key
 * (design.md D-7: "cap its length to reject pathological input"). Real
 * values are Meta phone-number-id strings, well under 100 characters — this
 * cap exists only to reject pathological input (e.g. a megabyte-sized
 * string arriving from a malformed/hostile webhook body) before it is ever
 * sent to Postgres, not to validate the key's actual shape.
 */
const MAX_KEY_LENGTH = 256;

/**
 * Resolves a `wa_phone_number_id` to the owning broker's `id` (design.md
 * D-7), by calling the `dirus_resolve_broker_id` SECURITY DEFINER function
 * installed by migration `0004_tenant_resolver.sql` (design.md D-1).
 *
 * This is a single statement on the pooled client, run OUTSIDE any
 * transaction and OUTSIDE `withBrokerContext` — there is no tenant context
 * to scope yet, because learning the tenant is the whole point of this
 * call. It returns an opaque `uuid` string or `null` (unknown key). It
 * never returns a row, a broker column other than `id`, or any table
 * handle — see `src/tenant.ts`'s `TenantDb` docstring and `src/index.ts`'s
 * barrel docstring for why that boundary is deliberate and must not be
 * widened.
 */
export async function resolveBrokerIdByWaPhoneNumberId(key: string): Promise<string | null> {
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `wa_phone_number_id exceeds the maximum accepted length of ${MAX_KEY_LENGTH} characters ` +
        `(received ${key.length}). Refusing to query.`,
    );
  }

  const result = await db.execute<{ dirus_resolve_broker_id: string | null }>(
    sql`select public.dirus_resolve_broker_id(${key})`,
  );

  return result.rows[0]?.dirus_resolve_broker_id ?? null;
}
