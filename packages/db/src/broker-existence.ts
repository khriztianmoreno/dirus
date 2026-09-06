import { eq } from "drizzle-orm";
import * as schema from "./schema/index.js";
import { assertUuid, withBrokerContext } from "./tenant.js";

/**
 * Task 6.4 (`policy-bulk-import`): the real implementation of `apps/api`'s
 * injected `ResolveBrokerExists` dependency (Phase 4,
 * `services/import-policies.ts`). Reuses `withBrokerContext` "as-is" —
 * tasks.md's Phase 1 note explicitly says no new migration or unproven
 * mechanism is needed here, unlike F2's D-1 tenant-resolver gate.
 *
 * `brokers`'s own `tenant_isolation` RLS policy (`0002_rls_policies.sql`) is
 * keyed on `id = current_setting('app.broker_id')` — self-referencing,
 * unlike every other table's `broker_id` column. Scoping the read to the
 * CANDIDATE id being checked is therefore itself the existence check: the
 * row becomes visible under its own id's context if and only if it exists.
 * No new SECURITY DEFINER function or narrow-access role (like
 * `tenant-resolution.ts`'s `dirus_tenant_resolver`) is needed, because this
 * read goes through the same `TenantDb` handle every other table read in
 * this codebase already uses (`tenant.ts`'s own docstring: "`TenantDb`
 * remains the only handle for that").
 *
 * A malformed (non-UUID) `brokerId` cannot possibly exist, so it resolves
 * to `false` rather than propagating `assertUuid`'s throw — the caller
 * (`runImportGuards`) treats "malformed" and "well-formed but absent"
 * identically, both correctly surfaced as the spec's 404 "unknown
 * brokerId" outcome, never an unhandled 500.
 */
export async function brokerExists(brokerId: string): Promise<boolean> {
  try {
    assertUuid(brokerId);
  } catch {
    return false;
  }

  return withBrokerContext(brokerId, async (tx) => {
    const rows = await tx
      .select({ id: schema.brokers.id })
      .from(schema.brokers)
      .where(eq(schema.brokers.id, brokerId))
      .limit(1);

    return rows.length > 0;
  });
}
