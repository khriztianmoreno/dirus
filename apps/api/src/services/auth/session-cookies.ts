/**
 * `admin-dashboard` (C1) task 3.18, design.md D-B: the two session-cookie
 * shapes and the `CreateSessionFn` contract, deliberately split out of
 * `create-session.ts` (which imports `@dirus/db`) so `routes/auth/
 * callback.ts` can import these pure, dependency-free builders as VALUES
 * without pulling `@dirus/db` into its own — or any offline test's —
 * import graph (design.md D-D's "no `@dirus/db` in the offline test import
 * graph" constraint). `@dirus/db` throws at import time without
 * `DATABASE_URL`, so even a type-only re-export path through a
 * `@dirus/db`-importing module would be a correctness trap: a barrel
 * re-export or non-`type`-only import elsewhere could accidentally pull it
 * in again. Keeping the pure pieces in their own file makes that
 * structurally impossible instead of merely a naming convention to
 * remember.
 */

/** `dirus_session`/`dirus_csrf` cookie `Max-Age`, design.md D-B: 7 days in seconds. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type CreateSessionParams = {
  brokerId: string;
  brokerUserId: string;
};

export type CreateSessionResult = {
  /** The raw, unhashed session token — set in the `dirus_session` cookie, never persisted. */
  rawSessionToken: string;
  /** The raw, unhashed CSRF token — set in the `dirus_csrf` cookie, never persisted. */
  rawCsrfToken: string;
};

export type CreateSessionFn = (params: CreateSessionParams) => Promise<CreateSessionResult>;

/**
 * `dirus_session` cookie (design.md D-B): `HttpOnly; Secure; SameSite=Lax`,
 * `Max-Age=604800`, `Path=/`, no `Domain` (host-only, per D-G's
 * same-origin architecture).
 */
export function buildSessionCookieHeader(rawSessionToken: string): string {
  return (
    `dirus_session=${rawSessionToken}; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`
  );
}

/**
 * `dirus_csrf` cookie (design.md D-B): identical attributes to
 * `dirus_session` MINUS `HttpOnly` — the SPA must be able to read this one
 * to echo it in the `X-Dirus-CSRF` header (design.md D-B, D-G's
 * `client.ts`).
 */
export function buildCsrfCookieHeader(rawCsrfToken: string): string {
  return `dirus_csrf=${rawCsrfToken}; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`;
}
