/**
 * Public surface of @dirus/db (design.md D-C: structural non-bypassability).
 *
 * This barrel exports ONLY `withBrokerContext`, `assertUuid`, `TenantDb`,
 * `resolveBrokerIdByWaPhoneNumberId`, the three `admin-dashboard` auth
 * resolvers (`resolveBrokerIdByEmail`, `resolveBrokerIdByMagicLinkTokenHash`,
 * `resolveBrokerIdBySessionTokenHash`), `brokerExists`, and the schema —
 * never the raw pooled `db` or `pool` from `./internal/client.ts`, and never
 * `unsafeAdminDb` from `./internal/admin.ts`. Combined with
 * `package.json#exports` (which publishes only `.` and `./schema`), the raw
 * client is unreachable from outside this package.
 *
 * CORRECTED at `admin-dashboard` (C1) tasks.md task 2.5 — design.md D-7
 * previously described `resolveBrokerIdByWaPhoneNumberId` as "the single
 * documented exception". That wording went stale the moment three more
 * functions joined the same narrow access class in `./auth-resolution.ts`
 * (design.md D-A), so it is corrected here to name all four as members of
 * ONE class, not a singular exception:
 *
 * Every OTHER query a caller issues goes through the transaction-scoped
 * tenant context opened by `withBrokerContext`, but these four functions
 * deliberately do not — tenant resolution logically precedes tenant
 * context, since the whole point of each call is to learn the `broker_id` a
 * caller does not yet have (from a `wa_phone_number_id`, an `email`, a
 * magic-link token hash, or a session token hash). Each runs outside any
 * transaction, on the pooled client directly, and returns only an opaque
 * `uuid` string or `null` — no row, no column other than the resolved id,
 * no table handle. See `./tenant.ts`'s `TenantDb` docstring for why this
 * access class must not be extended to any call returning row or column
 * data.
 *
 * `brokerExists` (`policy-bulk-import` task 6.4) is NOT a member of that
 * access class — it goes through `withBrokerContext`/`TenantDb` like any
 * other table read, reusing that proven mechanism as-is rather than adding
 * a new narrow-access class. See `./broker-existence.ts`'s own docstring.
 */
export { withBrokerContext, assertUuid } from "./tenant.js";
// `TenantDb` is type-only, erased at runtime — it will never appear in the
// runtime export allowlist above; that is expected, not an omission.
export type { TenantDb } from "./tenant.js";
export { resolveBrokerIdByWaPhoneNumberId } from "./tenant-resolution.js";
export {
  resolveBrokerIdByEmail,
  resolveBrokerIdByMagicLinkTokenHash,
  resolveBrokerIdBySessionTokenHash,
} from "./auth-resolution.js";
export { brokerExists } from "./broker-existence.js";
export * as schema from "./schema/index.js";
