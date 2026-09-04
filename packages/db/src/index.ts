/**
 * Public surface of @dirus/db (design.md D-C: structural non-bypassability).
 *
 * This barrel exports ONLY `withBrokerContext`, `assertUuid`, `TenantDb`,
 * `resolveBrokerIdByWaPhoneNumberId`, and the schema — never the raw pooled
 * `db` or `pool` from `./internal/client.ts`, and never `unsafeAdminDb` from
 * `./internal/admin.ts`. Combined with `package.json#exports` (which
 * publishes only `.` and `./schema`), the raw client is unreachable from
 * outside this package.
 *
 * design.md D-7 — the single documented exception: every OTHER query a
 * caller issues goes through the transaction-scoped tenant context opened by
 * `withBrokerContext`, but `resolveBrokerIdByWaPhoneNumberId` deliberately
 * does not — tenant resolution logically precedes tenant context, since the
 * whole point of that call is to learn the `broker_id` a caller does not yet
 * have. It runs outside any transaction, on the pooled client directly, and
 * returns only an opaque `uuid` string or `null` — no row, no other `brokers`
 * column, no table handle. See `./tenant.ts`'s `TenantDb` docstring for why
 * this narrower access class must not be extended to any call returning row
 * or column data.
 */
export { withBrokerContext, assertUuid } from "./tenant.js";
// `TenantDb` is type-only, erased at runtime — it will never appear in the
// runtime export allowlist above; that is expected, not an omission.
export type { TenantDb } from "./tenant.js";
export { resolveBrokerIdByWaPhoneNumberId } from "./tenant-resolution.js";
export * as schema from "./schema/index.js";
