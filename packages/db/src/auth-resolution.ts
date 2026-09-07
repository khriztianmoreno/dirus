import { sql } from "drizzle-orm";
import { db } from "./internal/client.js";

/**
 * `admin-dashboard` (C1) design.md D-A, tasks.md Phase 2: the three
 * pre-tenant lookups the login/session flow needs before a `broker_id` is
 * known — email → user (magic-link request), token hash → user (callback),
 * session hash → user (every dashboard request). Each calls its own
 * `SECURITY DEFINER` function installed by migration `0006_broker_auth.sql`
 * (design.md D-A), which extends `0004_tenant_resolver.sql`'s
 * `dirus_tenant_resolver` role/mechanism rather than inventing a second
 * pattern.
 *
 * All three are single statements on the pooled client, run OUTSIDE any
 * transaction and OUTSIDE `withBrokerContext` — same reasoning as
 * `resolveBrokerIdByChatwootAccountId` (`./tenant-resolution.ts`,
 * fix-chatwoot-tenant-resolution/F2.1 design.md D-E; formerly
 * `resolveBrokerIdByWaPhoneNumberId`): these resolve identity BEFORE a
 * broker context can exist, so they cannot be inside one — opening
 * `withBrokerContext` requires the `brokerId` these functions exist to
 * produce. Each returns an opaque `uuid` string or `null` (unknown key),
 * never a row, a column other than the resolved id, or any table handle.
 * See `src/tenant.ts`'s `TenantDb` docstring and `src/index.ts`'s barrel
 * docstring — both corrected by task 2.5 to describe
 * `resolveBrokerIdByChatwootAccountId` and these three functions together
 * as ONE access class, not a singular exception.
 *
 * The functions themselves decide nothing (design.md D-A): they filter only
 * on the key, never `expires_at`/`used_at`/`revoked_at`. Expiry, single-use
 * consumption, and idle timeout are evaluated inside `withBrokerContext`, in
 * the same transaction that mutates the row — these exports are not, and
 * must never become, the place that enforces those checks.
 */

/**
 * The maximum length accepted for the `email` lookup key. 254 is RFC 5321
 * §4.5.3.1.3's stated maximum total length for a mailbox (reverse-path /
 * forward-path), which is the realistic upper bound for a syntactically
 * valid address — unlike the two SHA-256 hashes below, an email is not
 * fixed-length, so this cap reasons about the value's own realistic shape
 * rather than reusing a hash's fixed-width bound.
 */
const MAX_EMAIL_LENGTH = 254;

/**
 * The maximum length accepted for a hex-encoded SHA-256 digest
 * (`token_hash` / `session_token_hash`, both hashed via `node:crypto`'s
 * `.digest("hex")` per design.md D-H). Unlike `MAX_EMAIL_LENGTH`, this is
 * NOT a realistic-upper-bound estimate — a SHA-256 hex digest is always
 * EXACTLY 64 characters by construction, so any longer value is
 * definitionally pathological input, never a legitimate value that merely
 * happens to be long.
 */
const MAX_SHA256_HEX_LENGTH = 64;

function assertLength(value: string, max: number, label: string): void {
  if (value.length > max) {
    throw new Error(
      `${label} exceeds the maximum accepted length of ${max} characters ` +
        `(received ${value.length}). Refusing to query.`,
    );
  }
}

/**
 * Resolves an `email` to the owning broker's `id` via
 * `dirus_resolve_broker_id_by_email` (migration `0006_broker_auth.sql`,
 * design.md D-A). Used by the magic-link request endpoint (Phase 3) to
 * learn `broker_id` before any `magic_link_tokens` row can be written.
 */
export async function resolveBrokerIdByEmail(email: string): Promise<string | null> {
  assertLength(email, MAX_EMAIL_LENGTH, "email");

  const result = await db.execute<{ dirus_resolve_broker_id_by_email: string | null }>(
    sql`select public.dirus_resolve_broker_id_by_email(${email})`,
  );

  return result.rows[0]?.dirus_resolve_broker_id_by_email ?? null;
}

/**
 * Resolves a hex-encoded SHA-256 `token_hash` to the owning broker's `id`
 * via `dirus_resolve_broker_id_by_magic_link` (migration
 * `0006_broker_auth.sql`, design.md D-A). Used by the magic-link callback
 * endpoint (Phase 3) — the caller hashes the raw token from the URL before
 * calling this function; the raw token itself is never passed here or
 * persisted (broker-auth spec "Token Is Never Stored Raw").
 */
export async function resolveBrokerIdByMagicLinkTokenHash(tokenHash: string): Promise<string | null> {
  assertLength(tokenHash, MAX_SHA256_HEX_LENGTH, "token hash");

  const result = await db.execute<{ dirus_resolve_broker_id_by_magic_link: string | null }>(
    sql`select public.dirus_resolve_broker_id_by_magic_link(${tokenHash})`,
  );

  return result.rows[0]?.dirus_resolve_broker_id_by_magic_link ?? null;
}

/**
 * Resolves a hex-encoded SHA-256 `session_token_hash` to the owning
 * broker's `id` via `dirus_resolve_broker_id_by_session` (migration
 * `0006_broker_auth.sql`, design.md D-A). Used by `session-auth.ts`
 * (Phase 4) on every dashboard request — the caller hashes the raw
 * `dirus_session` cookie value before calling this function.
 */
export async function resolveBrokerIdBySessionTokenHash(sessionTokenHash: string): Promise<string | null> {
  assertLength(sessionTokenHash, MAX_SHA256_HEX_LENGTH, "session hash");

  const result = await db.execute<{ dirus_resolve_broker_id_by_session: string | null }>(
    sql`select public.dirus_resolve_broker_id_by_session(${sessionTokenHash})`,
  );

  return result.rows[0]?.dirus_resolve_broker_id_by_session ?? null;
}
