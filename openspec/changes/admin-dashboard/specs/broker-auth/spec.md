# Broker Auth Specification

## Purpose

Define email magic-link authentication for `broker_users`: link issuance,
anti-enumeration, single-use/expiring token consumption, session
establishment via httpOnly signed cookie, and server-side tenant resolution
from the session (never from a client-supplied `brokerId`). This is the
first human-authentication mechanism in DIRUS and directly supersedes
`admin-auth.ts`'s stated expiry condition for any route a logged-in human
can reach.

## Requirements

### Requirement: Magic-Link Request Endpoint

The system MUST accept `POST /auth/magic-link { email }` and, for a matching
`broker_users.email`, generate a high-entropy random token, persist only its
hash (with `expires_at` 15 minutes out) in `magic_link_tokens`, and send the
raw token as a link via the configured email client. The endpoint MUST NOT
reveal, in its own response, whether the submitted email matched an existing
`broker_users` row.

#### Scenario: Known email receives a link

- GIVEN a `broker_users` row exists with `email = "ana@brokerx.com"`
- WHEN `POST /auth/magic-link { email: "ana@brokerx.com" }` is processed
- THEN a `magic_link_tokens` row is created with `expires_at` 15 minutes
  from now, `used_at IS NULL`, and an email is dispatched to that address

#### Scenario: Unknown email is accepted identically, writes nothing

- GIVEN no `broker_users` row has `email = "ghost@nowhere.com"`
- WHEN `POST /auth/magic-link { email: "ghost@nowhere.com" }` is processed
- THEN no `magic_link_tokens` row is created and no email is dispatched

### Requirement: Anti-Enumeration Response Is Indistinguishable

The response to `POST /auth/magic-link` MUST be identical — same HTTP status
code and same response body (byte-for-byte, no field present for one case
and absent for the other) — regardless of whether the submitted email
matched an existing `broker_users` row. The endpoint MUST NOT be usable as
an oracle to test whether a given email address has a `broker_users` account.

#### Scenario: Known and unknown email produce byte-identical responses

- GIVEN a `broker_users` row exists with `email = "ana@brokerx.com"` and no
  row exists with `email = "ghost@nowhere.com"`
- WHEN `POST /auth/magic-link` is called once with each email
- THEN both responses have the identical HTTP status code and identical
  response body content; no field (e.g. a `sent`/`found` boolean, an error
  message, or a differing status) distinguishes the two outcomes

#### Scenario: A malformed email still returns the generic response shape

- GIVEN a request body with `email = "not-an-email"`
- WHEN `POST /auth/magic-link` is processed
- THEN the response status and body match the shape used for a syntactically
  valid unknown email — malformed input MUST NOT produce a distinct
  validation-error response that narrows the anti-enumeration guarantee

### Requirement: Token Is Never Stored Raw

The system MUST store only a cryptographic hash of the magic-link token in
`magic_link_tokens.token_hash`. The raw token MUST exist only transiently
(request memory and the outbound email) and MUST NOT appear in any persisted
row, log line, or database column.

#### Scenario: The stored row contains no raw token

- GIVEN a magic-link request has been processed and a `magic_link_tokens`
  row was created
- WHEN that row is read directly from the database
- THEN `token_hash` does not equal the raw token value present in the
  dispatched email link, and no other column on that row contains the raw
  token value

### Requirement: Token Consumption Is Single-Use

The system MUST accept the callback request (`GET|POST /auth/callback?token=…`),
hash the presented token, look up an unused (`used_at IS NULL`) and
unexpired matching row, and set `used_at` atomically with session
establishment. A second presentation of the same raw token MUST be rejected
and MUST NOT establish a session.

#### Scenario: First use of a valid token succeeds and marks it used

- GIVEN a `magic_link_tokens` row exists, unexpired, with `used_at IS NULL`
- WHEN the callback is called with the corresponding raw token
- THEN a session is established and the row's `used_at` becomes non-null

#### Scenario: Second use of the same token is rejected

- GIVEN a `magic_link_tokens` row was already consumed by a prior successful
  callback (`used_at` is non-null)
- WHEN the callback is called again with the same raw token
- THEN the request is rejected, no new session is established, and
  `used_at` is unchanged from the first consumption

### Requirement: Token Expiry Is Enforced Server-Side

The system MUST reject a callback whose token's `expires_at` has passed,
regardless of whether the token has been used. Expiry MUST be computed from
the server clock against the stored `expires_at`, never trusted from client
input.

#### Scenario: An expired, unused token is rejected

- GIVEN a `magic_link_tokens` row exists with `expires_at` in the past and
  `used_at IS NULL`
- WHEN the callback is called with the corresponding raw token
- THEN the request is rejected and no session is established

#### Scenario: A token issued 15 minutes ago is still valid

- GIVEN a `magic_link_tokens` row exists with `expires_at` computed as
  exactly 15 minutes after `created_at`, and the current time is before
  `expires_at`
- WHEN the callback is called with the corresponding raw token
- THEN the request succeeds and a session is established

### Requirement: Session Established as httpOnly Signed Cookie With Sliding Expiry

On successful callback, the system MUST issue a signed, `httpOnly`,
`Secure`, `SameSite=Lax` session cookie identifying the `broker_user_id`.
The session MUST use a sliding 7-day idle expiry: an authenticated request
MUST renew the expiry, and a session with no activity for 7 days MUST no
longer authenticate.

#### Scenario: Successful callback issues a valid session cookie

- GIVEN a valid, unused, unexpired token is presented at the callback
- WHEN the callback completes
- THEN the response sets a cookie with `HttpOnly`, `Secure`, and
  `SameSite=Lax` attributes, and a subsequent authenticated request using
  that cookie succeeds

#### Scenario: An active session is renewed on use

- GIVEN a valid session cookie was issued 6 days ago and has been used daily
- WHEN an authenticated request is made using that cookie
- THEN the session's expiry is extended forward from the time of that
  request, not fixed at the original issuance time

#### Scenario: A session idle for 7 days no longer authenticates

- GIVEN a session cookie whose last-used timestamp is more than 7 days in
  the past
- WHEN a request is made using that cookie
- THEN the request is treated as unauthenticated

### Requirement: brokerId Is Never Accepted From the Client

No route protected by session authentication MUST accept a `brokerId`
parameter (query, body, path, or header) as a source of tenant scoping.
`broker_id` MUST be resolved exclusively from `broker_user_id` → `broker_id`
via the authenticated session, extending `tenant-resolver.ts`'s established
rule to human sessions.

#### Scenario: A supplied brokerId in the request body is ignored

- GIVEN an authenticated session for a broker user belonging to broker A
- WHEN a request to a session-protected endpoint includes
  `brokerId: "<broker-B-id>"` in its body or query string
- THEN the request is processed scoped to broker A (resolved from the
  session), and no data belonging to broker B is returned or written

#### Scenario: No session-protected route schema declares a brokerId input field

- GIVEN the input Zod schema for every session-protected route
- WHEN each schema is inspected
- THEN none declares a `brokerId` field as an accepted input

### Requirement: Logout Invalidates the Session

The system MUST accept a logout request that immediately invalidates the
current session, such that the previously valid cookie no longer
authenticates any subsequent request.

#### Scenario: A cookie used after logout is rejected

- GIVEN an authenticated session cookie
- WHEN logout is called, and the same cookie is then presented on a
  subsequent request
- THEN that subsequent request is treated as unauthenticated
