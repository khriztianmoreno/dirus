/**
 * Public surface of @dirus/db (design.md D-C: structural non-bypassability).
 *
 * This barrel exports ONLY `withBrokerContext`, `TenantDb`, and the schema —
 * never the raw pooled `db` or `pool` from `./internal/client.ts`, and never
 * `unsafeAdminDb` from `./internal/admin.ts`. Combined with
 * `package.json#exports` (which publishes only `.` and `./schema`), the raw
 * client is unreachable from outside this package: every query a caller
 * issues goes through the transaction-scoped tenant context.
 */
export { withBrokerContext, assertUuid } from "./tenant.js";
// `TenantDb` is type-only, erased at runtime — it will never appear in the
// runtime export allowlist above; that is expected, not an omission.
export type { TenantDb } from "./tenant.js";
export * as schema from "./schema/index.js";
