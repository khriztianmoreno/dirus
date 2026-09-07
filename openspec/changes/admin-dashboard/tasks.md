# Tasks: Admin dashboard

## Ordering constraint — read before touching anything below

**D-A is marked `NEEDS EMPIRICAL PROOF`** (design.md). No Postgres, Docker, or
Podman is reachable in the environment that authored this design, so the
three new `SECURITY DEFINER` functions (`dirus_resolve_broker_id_by_email`,
`dirus_resolve_broker_id_by_magic_link`, `dirus_resolve_broker_id_by_session`)
and their RLS policies on `broker_users`, `magic_link_tokens`, and `sessions`
— all defined in migration `0006_broker_auth.sql` — rest on reasoning about
Postgres RLS/role semantics, not execution. The *mechanism* passed live proof
once already, for `brokers`, in CI run 33899572167 (F2's D-1 gate). What is
explicitly **unproven** is that the same mechanism, reapplied to three **new**
tables, does not widen `dirus_app`'s own access — new policies are new
objects, and precedent is not proof (design D-A).

**Therefore Phase 1 is the migration plus its live proof, and nothing else.**
No middleware, no route, no frontend code — until D-A's five named live
assertions (design.md D-A, "Live assertions that must pass before
implementation is accepted") are green in CI. This mirrors F2's Phase 1 and
A1's Phase 1 exactly, and for the same reason: everything from Phase 2 onward
assumes the three resolver functions are safe, proven primitives to build on.

**Do not parallelize Phase 1 with any later phase.** If the gate fails —
specifically assertion 2 (the negative control) or assertion 4 (the catalog
guard) — design D-A's option table is wrong and the design itself changes.
Any middleware, route, or SPA code written before the gate passes is built on
an unproven foundation and is likely to be partially or wholly discarded.
This is a correctness ordering constraint, not a scheduling preference.

Phases 2 through 8 are otherwise dependency-ordered as design.md's own Open
Questions section forecasts them: (1) migration+proof, (2) `packages/db`
exports, (3) email integration + auth endpoints, (4) session/CSRF middleware,
(5) review queue, (6) metrics, (7) SPA shell + Caddy, (8) cross-cutting live
integration tests. Phases 5 and 6 do not depend on each other and MAY run in
parallel once Phase 4 is done, since both are ordinary authenticated routes
built on the same middleware; Phase 7's SPA shell has no data dependency on
Phase 5/6's route bodies and MAY start once Phase 4's middleware contract is
fixed, but its screens for review/metrics cannot be finished until 5/6 exist.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2500-3500 (migration + live proof, `packages/db` exports, email integration, auth routes, session/CSRF middleware, review queue, 6 metric queries, first-ever SPA in the monorepo, Caddy change) |
| 400-line budget risk | **High** — design.md and the proposal's own Risks table both flag this explicitly |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Phase 1 gate) -> PR 2 (Phase 2 db exports) -> PR 3 (Phase 3 email + auth endpoints) -> PR 4 (Phase 4 session/CSRF middleware) -> PR 5 (Phase 5 review queue) -> PR 6 (Phase 6 metrics) -> PR 7 (Phase 7 SPA shell + Caddy) -> PR 8 (Phase 8 live integration tests) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — user decision needed before `sdd-apply` starts Phase 2 |

Ask the user for chain strategy (stacked-to-main / feature-branch-chain /
size-exception) before `sdd-apply` starts Phase 2. Phase 1 must merge (or at
minimum sit green in CI) before Phase 2 begins, per the ordering constraint
above. This design itself named six PR slices as its own recommendation
(design.md Open Questions); this breakdown uses eight because Phase 1's live
proof and Phase 8's cross-cutting isolation tests are each independently
reviewable and neither is a natural sub-slice of any of the six named slices.

## Flagged dependency on O3 (email provider — no architectural stakes)

Stated once here rather than repeated at every task site. Per proposal
Product Decisions Round 2, O3 is resolved as "provider TBD at apply time, no
architectural stakes" — the interface is `sendMagicLink(to, url)` living in
`packages/integrations` alongside `chatwoot.ts`. Task 3.1 is where the actual
provider (e.g. Resend, chosen here for a documented reason: transactional-
email-first API, no legacy SMTP-relay setup burden, generous free tier
suitable for pilot volume) gets picked. No task in this breakdown blocks on
that pick being any particular provider — every consuming task (3.x auth
routes) is written against the `SendMagicLinkFn` interface, not a concrete
client, so O3's resolution is a small, contained substitution, never a
blocker to sequencing.

## Flagged: `infra/Caddyfile` is outside the normal workspace structure

Every other change in this project's history — F1 through C1's own Phases
1-6 — has stayed entirely inside `apps/`, `packages/`, and `openspec/`. Phase
7's task 7.9 is the first task in this project to modify `infra/Caddyfile`,
a deploy-config file outside any workspace package. Flagged explicitly so a
future reader does not assume it was touched incidentally; design D-G names
this reverse-proxy change as load-bearing for the zero-CORS, host-only-cookie
architecture the whole session design depends on.

## Phase 1: Migration + live proof (the gate) — design D-A, D-H; specs broker-auth "Token Is Never Stored Raw", data-model "magic_link_tokens Is RLS-Scoped..."

- [x] 1.1 RED: `packages/db/test/migrations/broker-auth-migration.test.ts`
      (new file, sibling to `policy-number-unique-index.test.ts`'s
      convention) — structural assertion reading the migration SQL file's
      text before it exists: asserts the file will contain `ALTER TABLE
      broker_users ADD COLUMN email text`, a plain `CREATE UNIQUE INDEX
      broker_users_email_key ON public.broker_users (email)` (explicitly NOT
      `NULLS NOT DISTINCT` — design D-H states this would break every
      existing row on the second insert), `CREATE TABLE magic_link_tokens`
      and `CREATE TABLE sessions` with `ENABLE ROW LEVEL SECURITY` and
      `FORCE ROW LEVEL SECURITY` on both, both a `USING` and `WITH CHECK`
      clause on each policy with the identical predicate, and three
      `CREATE FUNCTION dirus_resolve_broker_id_by_{email,magic_link,session}`
      declarations each `SECURITY DEFINER` with a non-null `SET search_path`.
      Traces to design D-A, D-H.
- [x] 1.2 GREEN: `packages/db/migrations/0006_broker_auth.sql`
      (`drizzle-kit generate --custom`, following 0004/0005's precedent) —
      per design D-H's exact sketch: `broker_users.email` column + plain
      unique index, `magic_link_tokens` and `sessions` tables with columns as
      specified, RLS policies mirroring `0002_rls_policies.sql`'s shape,
      `GRANT SELECT` on the narrow column sets D-A names to
      `dirus_tenant_resolver`, the three `SECURITY DEFINER` functions.
      Satisfies 1.1. Update
      `packages/db/src/schema/{broker_users,magic_link_tokens,sessions}.ts`
      (`broker_users.ts` modified, the other two created) so `drizzle-kit`'s
      drift check stays green. Traces to proposal P2/P3, design D-A/D-H.
- [x] 1.3 Write the down path as a committed script or comment block, in the
      documented order design D-H states: revoke `EXECUTE` -> drop functions
      -> drop policies -> revoke column grants -> drop tables -> drop the
      `email` index and column. `dirus_tenant_resolver` itself is NOT
      dropped (0004 owns it).
- [x] 1.4 RED then GREEN: extend
      `packages/db/test/migrations/rls-catalog-guard.test.ts` with the
      per-table guards design D-A's assertion 4 names: each new policy's `TO`
      clause names only `dirus_tenant_resolver`; each new function is
      `SECURITY DEFINER`, owned by that role, with a non-null pinned
      `proconfig` search_path; `EXECUTE` revoked from `PUBLIC`; `dirus_app`
      holds no membership in the resolver role (`pg_auth_members`). Write
      against the not-yet-applied migration so it fails for the right reason
      before 1.2, or immediately after — either order acceptable as long as
      RED is observed before GREEN.
- [x] 1.5 GREEN: confirm 1.4 passes once 1.2's migration is applied in CI's
      live Postgres.
- [x] 1.6 Create `packages/db/test/migrations/live-broker-auth.test.ts`,
      extending `live-rls-verification.test.ts`'s and
      `live-tenant-resolution.test.ts`'s established conventions exactly
      (`describe.skipIf(!LIVE_TEST_DATABASE_URL)`, throwaway schema,
      disposable fixture roles, `assertThrowawayDatabase`) — do not invent a
      second harness. Implements design D-A's five live assertions verbatim,
      cross-referenced by number, each as its own `it()`:
      1. **RED then GREEN — positive (D-A assertion 1)**: as the app fixture
         role with **no** `app.broker_id` set, each of
         `dirus_resolve_broker_id_by_email`,
         `dirus_resolve_broker_id_by_magic_link`, and
         `dirus_resolve_broker_id_by_session` returns the expected
         `broker_id` for a seeded row.
      2. **RED then GREEN — negative control, the whole point (D-A assertion
         2)**: in the *same session* that just resolved through each
         function, `SELECT count(*) FROM broker_users`,
         `... FROM sessions`, and `... FROM magic_link_tokens` each return
         `0`. Non-zero on any of the three is a stop-ship signal per the
         ordering constraint above.
      3. **RED then GREEN — miss (D-A assertion 3)**: an unknown key passed
         to each of the three functions returns `NULL`, not an error.
      4. **RED then GREEN — catalog guard (D-A assertion 4)**: re-assert,
         from the live connection (not just the structural SQL-text check in
         1.4), that each new policy's `TO` clause names only
         `dirus_tenant_resolver`, each function is owned by that role with a
         pinned `search_path`, `EXECUTE` is revoked from `PUBLIC`, and
         `dirus_app` has no membership in `dirus_tenant_resolver` via
         `pg_auth_members`.
      5. **RED then GREEN — cross-tenant, end-to-end, the non-negotiable
         success criterion (D-A assertion 5)**: seed two brokers (A and B),
         issue a session for broker A via direct inserts against this
         throwaway fixture, and confirm that querying `extractions`,
         `renewals`, and a stand-in metrics query with `app.broker_id` set to
         A's id returns zero of B's rows — **with a positive control**
         (broker A's own rows ARE visible) proving the assertion is not
         vacuous.
- [x] 1.7 Run the full Phase 1 test suite against CI's live Postgres service
      container. **This is the acceptance gate.** If assertion 2 (negative
      control) or assertion 4 (catalog guard) fails, STOP — do not proceed
      to Phase 2. Record the failure, revisit design D-A's option table, and
      treat this as a design change, not an implementation bug to patch
      around.
- [x] 1.8 Live: multiple `broker_users` rows with `email IS NULL` coexist
      after 1.2's migration; a duplicate non-null email across two different
      brokers is rejected by the plain unique index (not
      `UNIQUE(broker_id, email)`). Traces to data-model spec scenarios "A
      duplicate email across two different brokers is rejected" and
      "Multiple broker_users rows with NULL email are permitted".
- [x] 1.9 Live: issue a magic-link token row directly, then read the stored
      row and assert `token_hash` does not equal the raw token value, and no
      other column on that row contains it. Traces to broker-auth spec "The
      stored row contains no raw token".
- [x] 1.10 Update this change's `data-model` delta spec status/notes to
      record that D-A's live proof passed (or, if it did not, that the gate
      blocked progress and why).

**Blocked on open question**: none — Phase 1 is self-contained and is itself
the mechanism for resolving D-A's "NEEDS EMPIRICAL PROOF" status. Everything
in Phase 2 onward is blocked on task 1.7 passing.

## Phase 2: `packages/db` exports — design D-A's three resolver functions, mirrors `tenant-resolution.ts`'s D-7 pattern

- [x] 2.1 RED: `packages/db/test/barrel-surface.test.ts` — extend the
      exhaustive allowlist assertion to expect
      `resolveBrokerIdByEmail`, `resolveBrokerIdByMagicLinkTokenHash`, and
      `resolveBrokerIdBySessionTokenHash` alongside the existing exports.
      Write before the exports exist so this fails for the right reason
      (export missing).
- [x] 2.2 RED: unit tests for each of the three new functions — input length
      caps reject pathological input before any query runs, mirroring D-7's
      "cap its length to reject pathological input" convention already
      applied to `resolveBrokerIdByWaPhoneNumberId`. Write against a
      stub/mock of the query layer so this runs offline.
- [x] 2.3 GREEN: create `packages/db/src/auth-resolution.ts` — the three
      narrow lookups, each a single statement on the pooled client, no
      transaction, returning `string | null` and nothing else (bare `uuid`,
      never row data — the same invariant D-A's functions themselves
      enforce at the SQL layer). Depends on Phase 1's three resolver
      functions existing and being proven safe.
- [x] 2.4 GREEN: add the three exports to `packages/db/src/index.ts`,
      satisfying 2.1.
- [x] 2.5 Correct `packages/db/src/tenant.ts`'s `TenantDb` docstring and
      `packages/db/src/index.ts`'s barrel docstring: both currently describe
      `resolveBrokerIdByWaPhoneNumberId` as the "second, deliberately
      narrower access class" and "the single documented exception" — with
      three more functions in the same class, correct both docstrings to
      name all four as members of that access class (bare-uuid-only,
      never a row handle) rather than silently letting the "single
      exception" claim go stale. State explicitly in the diff what changes
      and why, per F2's D-7 docstring-correction discipline.
- [x] 2.6 RED then GREEN, or mutation-tested if RED is impossible: a test
      asserting each of the three new functions never opens a
      `withBrokerContext` transaction and returns no table handle — return
      type is `string | null`, never a row object. If correct by
      construction from the type signature alone, validate by mutation:
      temporarily change one implementation to leak a row object, confirm
      the test fails, then restore. State in the test file which convention
      was used.
- [x] 2.7 Live: extend `live-broker-auth.test.ts` (or add a focused sibling)
      to call the three exported functions themselves — not the raw SQL —
      against the throwaway fixture, so the exported surface, not just the
      underlying SQL, is proven safe end-to-end.

## Phase 3: Email integration + magic-link request/callback endpoints — design D-C, D-A's data flow; spec broker-auth "Magic-Link Request Endpoint", "Anti-Enumeration Response Is Indistinguishable", "Token Consumption Is Single-Use", "Token Expiry Is Enforced Server-Side"

- [x] 3.1 **O3 pick (no architectural stakes, proposal Round 2)**: choose
      Resend as the transactional email provider — deliverability-first API,
      no SMTP relay to operate, workable free tier for pilot volume. Add
      `packages/integrations/src/email/resend.ts` implementing
      `sendMagicLink(to: string, url: string): Promise<void>` behind a
      `SendMagicLinkFn` type so every consumer (Phase 3's routes) depends on
      the interface, not the concrete client. Record the choice in this
      task's checkbox; no test-first step for the provider pick itself, but
      the client wrapper gets a thin unit test asserting it calls the
      provider SDK with the expected `to`/subject/body shape, using a
      mocked SDK client (no real network call in tests).
- [x] 3.2 RED: `apps/api/src/env.ts` test — extend the `readRequired`
      pattern to assert `EMAIL_API_KEY`, `EMAIL_FROM_ADDRESS`, and
      `DASHBOARD_BASE_URL` throw at import time when absent. Write before
      the vars are added.
- [x] 3.3 GREEN: add the new vars to `apps/api/src/env.ts` and
      `.env.example`, satisfying 3.2.
- [x] 3.4 RED: `packages/schemas/src/auth/magic-link-request.ts` test — a
      request body with a syntactically valid email passes; a body with
      `email = "not-an-email"` fails Zod parsing. Write against the
      not-yet-written schema.
- [x] 3.5 GREEN: the Zod request schema, satisfying 3.4. Re-export from the
      barrel.
- [x] 3.6 RED: `apps/api/src/routes/auth/magic-link.ts` test — a known email
      (via a fake `resolveBrokerIdByEmail` returning a broker id) results in
      exactly one call to a fake `sendMagicLink`, dispatched **after** a fake
      transaction-commit call, never before. Assert ordering via call-order
      spies, not just call-count — this is where D-C's "email send is off
      the response path, after commit" ordering is proven, not merely
      described. Traces to design D-C's data-flow diagram.
- [x] 3.7 RED: same file — a known email results in exactly one
      `magic_link_tokens` insert call (fake writer) with a hashed token, an
      `expires_at` 15 minutes out, and the raw token passed only to
      `sendMagicLink`, never to the writer. Traces to broker-auth spec
      "Known email receives a link".
- [x] 3.8 RED: same file — an unknown email (fake resolver returns `null`)
      results in **zero** calls to both the writer and `sendMagicLink`.
      Traces to broker-auth spec "Unknown email is accepted identically,
      writes nothing".
- [x] 3.9 RED — **the single most load-bearing test in this phase, per task
      brief**: `apps/api/src/routes/auth/magic-link.test.ts` asserts
      **byte-identical response bodies AND status codes** across three
      inputs dispatched to the same running `createApp` instance in the same
      test: a known email, an unknown-but-well-formed email, and a
      well-formed email belonging to a user with `email IS NULL` semantics
      (i.e. simulate via the fake resolver returning `null` for a
      syntactically valid address). Assert `res.status === 202` for all
      three AND `await res.text()` is the identical string across all three
      — not `res.json()` structurally-equal, since two differently-ordered
      but structurally-equal JSON bodies would wrongly pass a structural
      check and hide exactly the leak this test exists to catch. Also assert
      response headers contain no `Set-Cookie` and no differing
      correlation-id-shaped header across the three. A weak assertion here
      (e.g. "returns 202") is explicitly rejected by the task brief as
      insufficient. Traces to broker-auth spec "Anti-Enumeration Response Is
      Indistinguishable", scenario "Known and unknown email produce
      byte-identical responses".
- [x] 3.10 RED: same file — a malformed, non-email-shaped body (fails Zod)
      returns the **same** status/body shape as 3.9's well-formed-unknown
      case — a `400` is explicitly rejected by design D-C except when the
      value is not email-shaped at all, and even then the body must not
      differ in the way that would create a distinct oracle. Reconcile
      against design D-C precisely: `400` is permitted ONLY for genuinely
      non-email-shaped input, and even that response's status/shape must not
      let an attacker distinguish "malformed" from "well-formed-but-unknown"
      in a way exploitable as an enumeration oracle beyond what D-C already
      accepts. Traces to broker-auth spec "A malformed email still returns
      the generic response shape".
- [x] 3.11 GREEN: `apps/api/src/routes/auth/magic-link.ts` implementing
      D-C's exact ordering: resolve `broker_id` (2.3's function, injected) ->
      null -> `202` immediately, no write, no email -> found ->
      `withBrokerContext(insert magic_link_tokens)` (COMMIT) -> dispatch
      `sendMagicLink(...)` detached with a mandatory `.catch(log)` (the Node
      adapter has no `waitUntil`; an unhandled rejection here crashes the
      process, per design D-C) -> return `202`. Satisfies 3.6-3.10.
- [x] 3.12 RED: `apps/api/src/routes/auth/callback.ts` test — a valid,
      unused, unexpired token (fake resolver + fake atomic-consume function)
      results in a session-creation call and a `302` redirect with a
      `Set-Cookie` header; the raw token never appears in the redirect `Location`.
      Traces to broker-auth spec "First use of a valid token succeeds and
      marks it used", design D-A's callback data-flow.
- [x] 3.13 RED: same file — a second presentation of the same token (fake
      atomic-consume returns "already used") is rejected, no new session
      call happens. Traces to spec "Second use of the same token is
      rejected".
- [x] 3.14 RED: same file — an expired-but-unused token (fake atomic-consume
      returns "expired") is rejected, no session call happens. Traces to
      spec "An expired, unused token is rejected".
- [x] 3.15 GREEN: `apps/api/src/routes/auth/callback.ts` and
      `apps/api/src/services/auth/consume-magic-link.ts` — the atomic
      `UPDATE magic_link_tokens SET used_at = now() WHERE token_hash = $1
      AND used_at IS NULL AND expires_at > now() RETURNING …` inside
      `withBrokerContext`, single-use and expiry both checked in the same
      transaction that creates the session, per design D-A's stated
      invariant that the resolver functions decide nothing. Satisfies
      3.12-3.14.
- [x] 3.16 RED then GREEN (live, `describe.skipIf(!LIVE_TEST_DATABASE_URL)`,
      per F2's Phase 5.10 precedent for the boundary where a real
      transaction is needed): issue a real token via 3.11's insert path,
      consume it once via 3.15's real update — succeeds, `used_at` becomes
      non-null; consume the same raw token again — rejected, `used_at`
      unchanged from the first consumption. Traces to spec scenarios "First
      use... succeeds and marks it used" and "Second use... is rejected",
      run end-to-end rather than against fakes.
- [x] 3.17 RED then GREEN (live): a token whose `expires_at` is exactly 15
      minutes after `created_at` and whose current time is just before
      expiry succeeds; a token whose `expires_at` is in the past is
      rejected. Traces to spec "A token issued 15 minutes ago is still
      valid" and "An expired, unused token is rejected".
- [x] 3.18 GREEN: `apps/api/src/services/auth/create-session.ts` — on
      successful callback, generate the opaque 32-byte session id and the
      independent 32-byte CSRF value (design D-B), SHA-256 hash both,
      persist `sessions` row with `idle_expires_at = now() + 7 days`, and
      set the two cookies exactly as design D-B specifies (`dirus_session`
      `HttpOnly; Secure; SameSite=Lax`, `dirus_csrf` same attributes minus
      `HttpOnly`), both `Max-Age=604800`, no `Domain` attribute.
- [x] 3.19 Verify `pnpm --filter @dirus/api test` and
      `pnpm --filter @dirus/integrations test` pass with Phase 3's routes
      wired against fakes only (no `@dirus/db` in the offline test import
      graph, per D-5's established constraint).

## Phase 4: Session-auth middleware + CSRF guard — design D-D, D-B; spec broker-auth "brokerId Is Never Accepted From the Client", "Session Established as httpOnly Signed Cookie With Sliding Expiry", "Logout Invalidates the Session"

- [x] 4.1 RED: `apps/api/src/middleware/session-auth.ts` test — a request
      with no cookie, or a cookie failing the shape check (wrong length /
      non-base64url), is rejected `401` with an empty body, mirroring
      `webhook-auth.ts`'s test convention, and the injected `resolveSession`
      fake is never called for the shape-check-failure case (assert via a
      spy/counter). Write before the middleware exists.
- [x] 4.2 RED: same file — a well-formed cookie whose hash resolves to
      `null` via the fake `resolveSession` is rejected `401`, and
      `c.var.brokerId` is never set.
- [x] 4.3 RED: same file — a well-formed cookie that resolves successfully
      sets `c.var.brokerId` and `c.var.session` from the resolver's return
      value alone — never from any path param, query string, or body field,
      even when one is present in the same request carrying a conflicting
      value (construct the test request with a body containing
      `brokerId: "<some-other-id>"` and assert the resolved `c.var.brokerId`
      is the session's, not the body's). Traces to broker-auth spec "A
      supplied brokerId in the request body is ignored".
- [x] 4.4 GREEN: `apps/api/src/middleware/session-auth.ts` per design D-D's
      exact type contract (`ResolvedSession`, `ResolveSession`,
      `SessionAuthVariables`), satisfying 4.1-4.3. Update `AppVariables` in
      `apps/api/src/app.ts` to include `SessionAuthVariables`, using the
      **same** `brokerId` context key as `TenantResolverVariables` — not a
      distinct `sessionBrokerId` key — per design D-D's explicit reasoning
      (one Hono context map; the key means the same thing in both:
      server-resolved tenant, never client input).
- [x] 4.5 RED: `apps/api/src/middleware/csrf-guard.ts` test — a mutating
      request (`POST`/`PATCH`/`PUT`/`DELETE`) missing the `X-Dirus-CSRF`
      header, or presenting a header whose `sha256` does not match
      `session.csrfTokenHash`, is rejected `403` with `timingSafeEqual`
      comparison (mirroring `admin-auth.ts`'s `constantTimeEquals` helper),
      and downstream never runs (spy/counter on a fake next-handler).
- [x] 4.6 RED: same file — a `GET`/`HEAD` request is exempt from the CSRF
      check regardless of header presence. Traces to design D-B's "Safe
      methods... are exempt" statement.
- [x] 4.7 RED: same file — a mutating request with the correct header
      passes through.
- [x] 4.8 GREEN: `apps/api/src/middleware/csrf-guard.ts`, mounted after
      session-auth (reads `c.var.session.csrfTokenHash`), only on mutating
      routes, satisfying 4.5-4.7.
- [x] 4.9 RED then GREEN (live): a session cookie issued 6 days ago whose
      `last_seen_at` is updated on use has its `idle_expires_at` extended
      forward from the request time, not the original issuance time; a
      session idle for 7+ days no longer authenticates. Traces to
      broker-auth spec "An active session is renewed on use" and "A session
      idle for 7 days no longer authenticates". Implement the sliding-window
      throttle design D-B names (refresh at most once per ~15 minutes of
      activity, not on every request) in
      `apps/api/src/services/auth/touch-session.ts`.
- [x] 4.10 (CONFIRMED — CI run 34129125829: session-lifecycle.live.test.ts 3/3 green, no deadlock/serialization error observed under Promise.all-dispatched concurrent GETs, idle_expires_at ended in a consistent state) **NEEDS EMPIRICAL PROOF flagged by design.md's own Open
      Questions**: whether the sliding-window `UPDATE sessions` under
      `withBrokerContext` on a `GET` deadlocks or serializes under
      concurrent requests from one session. Write a live concurrency test
      (`Promise.all` dispatch, not sequential, mirroring F2's Phase 6
      convention) firing several concurrent authenticated `GET` requests on
      the same session and asserting no deadlock/serialization error and
      `idle_expires_at` ends in a consistent state. This is a design.md
      Open Question, not resolved by this task list's scoping alone — record
      the result here rather than silently assuming success.
- [x] 4.11 RED: `apps/api/src/routes/auth/logout.ts` test — logout sets
      `sessions.revoked_at` (fake write) and the same cookie presented
      afterward (via `session-auth`'s resolver now correctly returning
      `null` for a revoked session — assert this at the resolver-fake level)
      is treated as unauthenticated. Traces to broker-auth spec "A cookie
      used after logout is rejected".
- [x] 4.12 GREEN: `apps/api/src/routes/auth/logout.ts` and the real
      `resolveSession` implementation's `revoked_at IS NULL` predicate in
      `packages/db/src/auth-resolution.ts` (or a session-specific
      companion), satisfying 4.11.
- [x] 4.13 RED then GREEN (live): full end-to-end — issue a real session via
      3.15/3.18's real callback path, call logout via the real route, then
      present the same cookie to a real session-protected route and confirm
      `401`.
- [x] 4.14 Structural: a test inspecting every session-protected route's
      input Zod schema asserts none declares a `brokerId` field as an
      accepted input. Traces to broker-auth spec "No session-protected route
      schema declares a brokerId input field" — this is also named as a
      Success Criteria checkbox, verifiable by inspection.
- [x] 4.15 Verify `pnpm --filter @dirus/api test` and
      `pnpm --filter @dirus/api typecheck` pass with session-auth and
      csrf-guard wired but no dashboard data route yet mounted (that is
      Phases 5-6).

## Phase 5: Extraction review queue — design D-E; spec extraction-review (all requirements)

May run in parallel with Phase 6 once Phase 4 is complete; both are ordinary
authenticated routes on the same middleware with no data dependency on each
other.

- [ ] 5.1 RED: `packages/schemas/src/extraction-envelope.ts` test — a
      well-formed `Record<field, { value, confidence }>` object parses via
      `extractionEnvelope.safeParse`; a `confidence` outside `[0, 1]` fails;
      `value: unknown` accepts any shape. Write against the not-yet-written
      schema.
- [ ] 5.2 GREEN: the Zod schema per design D-E's exact shape, `@provisional`
      docstring stating it is owned by B2 on arrival. Re-export from the
      barrel.
- [ ] 5.3 RED: `apps/api/src/services/to-envelope.ts` test —
      `toEnvelope(output, confidence)` zips `Record<field, unknown>` and
      `Record<field, number>` into the envelope shape for a well-formed pair
      with two fields at different confidence levels (e.g. `policyNumber:
      0.92`, `endDate: 0.61`), and each field's value/confidence appear as a
      distinct entry — not merged into one opaque object. Traces to
      extraction-review spec "Fields below 0.85 are individually visible".
- [ ] 5.4 RED: same file — a shape `toEnvelope`/`safeParse` does not
      recognize (e.g. `output`/`confidence` columns whose keys do not
      overlap, or a non-numeric confidence value) results in `safeParse`
      failure being caught and the function returning a raw-JSON fallback
      marker rather than throwing. Traces to extraction-review spec "An
      extraction shape the stub does not recognize does not crash the
      endpoint".
- [ ] 5.5 GREEN: `packages/schemas`/`apps/api`'s `toEnvelope` function,
      satisfying 5.3-5.4, using `safeParse` never `parse` per design D-E.
- [ ] 5.6 RED: `apps/api/src/routes/dashboard/review-queue.ts` test (list
      endpoint) — given a fake review-queue query returning three rows for
      broker B (two `needs_review = true`, one `false`), the response
      contains exactly the two flagged rows. Traces to extraction-review
      spec "Only flagged rows appear in the queue".
- [ ] 5.7 RED: same file — the query function is injected and asserted to be
      called with `c.var.brokerId` (from session-auth), never a
      client-supplied value, and a fake returning broker-A-only rows for a
      broker-A session never includes broker-B rows. Traces to spec "The
      queue is scoped to the caller's own broker".
- [ ] 5.8 GREEN: `apps/api/src/routes/dashboard/review-queue.ts` (GET,
      list) and `apps/api/src/services/queries/needs-review-queue.ts` — the
      real query against `extractions WHERE needs_review = true AND
      broker_id = ...` (RLS-scoped via `withBrokerContext`), rendering each
      row through 5.5's `toEnvelope`. Satisfies 5.6-5.7.
- [ ] 5.9 RED: `apps/api/src/routes/dashboard/review-queue.ts` test
      (correction endpoint) — a correction request body including a
      `correctedBy` field naming a different broker user results in the
      **session's** `broker_user_id` being passed to the fake write
      function, never the body's value. Traces to spec "correctedBy is taken
      from the session, not the request body".
- [ ] 5.10 RED: same file — a successful correction call results in exactly
      one write-function call setting `correctedOutput` and `correctedBy`,
      and `needsReview = false`. Traces to spec "A correction persists both
      correctedOutput and correctedBy" and "Resolving a Correction Clears
      needs_review".
- [ ] 5.11 RED: same file — a correction request failing Zod validation
      (e.g. a required field missing) results in zero calls to the write
      function. Traces to spec "A failed correction attempt leaves
      needs_review unchanged".
- [ ] 5.12 GREEN: the correction route/service, satisfying 5.9-5.11.
- [ ] 5.13 RED then GREEN (live): a flagged extraction fixture row, after a
      real correction call, has `needs_review = false`,
      `correctedOutput`/`correctedBy` populated, and no longer appears in a
      subsequent real call to the list endpoint. Traces to spec "A resolved
      extraction disappears from the queue" — run against seeded fixture
      data since no real extractions exist yet (per proposal's stated
      testing approach for this phase).
- [ ] 5.14 RED then GREEN, or mutation-tested if RED is impossible: a test
      asserting no code path in this capability writes a guessed or
      auto-filled value to `correctedOutput` for a sub-0.85-confidence field
      without an explicit reviewer-submitted value for that field. If
      correct by construction (the correction route only ever writes what
      the request body explicitly supplies), validate by mutation:
      temporarily add an auto-fill branch, confirm the test fails, then
      restore. Traces to spec "Extraction Confidence Threshold and Re-Ask
      Rule Apply Unchanged", scenario "A low-confidence field is never
      auto-accepted without human input".
- [ ] 5.15 Verify `pnpm --filter @dirus/api test` and
      `pnpm --filter @dirus/schemas test` pass with the review queue wired
      against fakes and seeded-fixture live tests.

## Phase 6: Product metrics — design D-F; spec product-metrics (all requirements)

May run in parallel with Phase 5 once Phase 4 is complete.

- [ ] 6.1 RED: `apps/api/src/services/metrics/copilot-share.ts` test — given
      a fixture of `conversations` rows for broker B including some with
      `kind = 'copilot'`, the function returns the correct count and
      `empty: false`. Given zero `conversations` rows, returns `empty: true`
      and a well-formed `MetricResult` shape (not `null`, not an error).
      Traces to product-metrics spec "Each metric has a distinct, callable
      endpoint" and "An endpoint against an empty table returns a valid
      empty-state shape".
- [ ] 6.2 GREEN: `copilot-share.ts` per design D-F's `MetricResult<T>` shape
      (`value`, `sampleSize`, `empty`, optional `caveat`), satisfying 6.1.
      The `caveat` field carries H1's uninstrumented-denominator disclosure
      (O8) as data, not hardcoded UI copy, per design D-F.
- [ ] 6.3 RED then GREEN (live) — **the exact-delta assertion the task brief
      requires, not a weak "returns 200"**: insert one `conversations` row
      with `kind = 'copilot'` for broker B, call the endpoint, record the
      count as `M`; insert exactly one more such row; call again; assert the
      returned count is precisely `M + 1`, not merely "changed" or
      "increased". Traces to product-metrics spec "The copilot-usage metric
      changes when a copilot conversation is added" — this is the
      discriminating live-query proof the task brief calls out as the place
      a weak assertion would silently lose the spec's intent.
- [ ] 6.4 RED: `apps/api/src/services/metrics/renewal-status.ts` test —
      `renewals GROUP BY status` fixture returns correct per-status counts;
      empty table returns `empty: true`.
- [ ] 6.5 GREEN: `renewal-status.ts`, satisfying 6.4.
- [ ] 6.6 RED then GREEN (live) — exact-delta: seed `N` renewals with
      `status = 'paid'` for broker B, call the endpoint, record `N`; insert
      exactly one more `status = 'paid'` renewal; call again; assert the
      returned `paid` count is precisely `N + 1`. Traces to product-metrics
      spec "The renewal-funnel metric changes when a renewal's status
      changes".
- [ ] 6.7 RED: `apps/api/src/services/metrics/needs-review-rate.ts` test —
      `extractions.needs_review` count/rate against a fixture with a mix of
      flagged/unflagged rows; empty table returns `empty: true`.
- [ ] 6.8 GREEN: `needs-review-rate.ts`, satisfying 6.7, reusing the same
      partial index Phase 5's queue query reads.
- [ ] 6.9 RED: `apps/api/src/services/metrics/conversation-status-snapshot.ts`
      test — a fixture with two `conversations` rows both `status =
      'resolved'` (one previously escalated, one never) are counted
      identically under `resolved`, and the response carries an explicit
      `snapshotType: "current-state"` (or equivalent) marker distinguishing
      it from an at-close measurement. Traces to product-metrics spec "The
      endpoint's response is marked as a snapshot, not an at-close
      measurement" and "A conversation escalated then later closed is
      indistinguishable from one that never involved a human".
- [ ] 6.10 GREEN: `conversation-status-snapshot.ts`, satisfying 6.9. The
      P8/O8 disclosure travels as the `caveat`/`snapshotType` field on the
      `MetricResult`, per design D-F.
- [ ] 6.11 RED: `apps/api/src/services/metrics/time-to-first-renewal.ts`
      test — a fixture with `brokers.created_at` and a first
      `messages.type = 'template'` timestamp computes the correct date-diff;
      empty/no-template-message-yet state returns `empty: true`.
- [ ] 6.12 GREEN: `time-to-first-renewal.ts`, satisfying 6.11.
- [ ] 6.13 RED: `apps/api/src/services/metrics/cost.ts` test — with no
      Langfuse client configured (or a fake `LangfuseCostSource` returning
      "unavailable"), the endpoint returns an explicit
      `status: "deferred"` (or equivalent) marker, never a fabricated
      numeric value, never a bare `0` that could be mistaken for a real
      measurement. Traces to product-metrics spec "Cost Metric Discloses
      Deferred State".
- [ ] 6.14 GREEN: `cost.ts` behind the `LangfuseCostSource` interface design
      D-F names, satisfying 6.13. **Droppable per proposal P6** — if
      schedule pressure forces a cut, this is the metric to cut, not a
      track; state explicitly in the PR description if dropped.
- [ ] 6.15 RED: `apps/api/src/routes/dashboard/metrics.ts` test — none of
      the six metric routes' input Zod schemas accept a `brokerId` field;
      each route resolves `broker_id` from `c.var.brokerId` (session-auth)
      exclusively. Traces to product-metrics spec "Metrics Are Scoped to the
      Authenticated Broker" and "Broker A's metrics never include Broker
      B's rows" (offline half; the live half is Phase 8).
- [ ] 6.16 GREEN: wire all six metric functions behind
      `apps/api/src/routes/dashboard/metrics.ts`, one endpoint per metric,
      each running inside the caller's `withBrokerContext` (never opening
      its own, per design D-F's reentrancy-guard note). Satisfies 6.15.
- [ ] 6.17 Verify `pnpm --filter @dirus/api test` passes with all six metric
      endpoints wired against fakes and seeded-fixture/empty-table live
      tests for the five non-Langfuse metrics.

## Phase 7: SPA shell + Caddy reverse-proxy — design D-G, D-7/proposal P7

- [ ] 7.1 Scaffold `apps/dashboard/` as a standalone Vite + React app —
      `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`,
      `src/main.tsx`, `src/App.tsx`. Per proposal P7 and design D-G: no
      shared preset in `packages/config` (single consumer today), standalone
      build config. First frontend app in the monorepo — flag any workspace
      tooling gap (lint config, `pnpm -r typecheck`/`test` inclusion) found
      while wiring this in, per the proposal's Risks table entry on
      unplanned tooling burden.
- [ ] 7.2 Configure Vite's `server.proxy` (`/api` -> `http://localhost:3000`)
      for dev, per design D-G, so the dev origin behaves same-origin exactly
      like prod will via Caddy.
- [ ] 7.3 `src/api/client.ts` — the **only** place `fetch()` is called
      anywhere in `apps/dashboard`, per design D-G's stated discipline.
      Centralises `credentials: "include"`, the `X-Dirus-CSRF` header on
      mutating requests (reading the non-`HttpOnly` `dirus_csrf` cookie),
      and a `401` -> redirect-to-`/login` handler.
- [ ] 7.4 `src/components/RequireSession.tsx` — calls `GET /api/auth/me`
      once on mount; `401` redirects to `/login`; success renders children.
- [ ] 7.5 `src/routes/login.tsx` — the magic-link request form, posting to
      `/api/auth/magic-link` via `client.ts`, showing the fixed `{"status":
      "accepted"}` acknowledgement copy regardless of outcome (the UI must
      not introduce its own enumeration oracle on top of the API's, e.g. by
      showing a different message for a network error vs. a processed
      request in a way that leaks which case occurred).
- [ ] 7.6 `src/routes/auth-callback.tsx` — handles the redirect landing from
      `GET /api/auth/callback`, shows an error state when redirected with
      `?error`.
- [ ] 7.7 `src/routes/review-queue.tsx` — lists flagged extractions via
      Phase 5's endpoint, renders per-field value/confidence, a correction
      form per row, degrading to raw-JSON display when `toEnvelope`'s
      fallback marker is present (per design D-E, never crashing on an
      unrecognized shape).
- [ ] 7.8 `src/routes/metrics.tsx` — six panels, one per Phase 6 metric,
      each rendering its `empty`/`sampleSize`/`caveat` fields explicitly
      (a distinct "no data yet" state, not a bare zero), and the
      conversation-resolution panel labelled in the UI as a current-state
      snapshot, never as the §12 at-close metric — this is a named proposal
      Success Criteria checkbox, not incidental copy.
- [ ] 7.9 **Flagged — outside the normal workspace structure**: modify
      `infra/Caddyfile` to add `handle_path /api/*` on `app.dirus.io`
      routing to the API container, per design D-G. This is the first task
      in this project's history to touch `infra/`.
- [ ] 7.10 Wire `apps/dashboard/package.json`'s `build` script producing
      `dist/`, and confirm the bundle can be served statically and issue
      real credentialed requests against a running `apps/api` instance
      (manual verification for v1 — no browser runner exists in this repo,
      per design.md's Testing Strategy table).
- [ ] 7.11 Verify `pnpm -r typecheck`, `pnpm -r test`, `pnpm run lint`, and
      `pnpm run lint:deps` all pass with `apps/dashboard` in the workspace —
      a named proposal Success Criteria checkbox.

## Phase 8: Live integration tests — cross-tenant isolation (non-negotiable) + admin-auth disposition record

These tests dispatch through the real routes end-to-end, mirroring F2's
Phase 6 and A1's Phase 7 conventions: a positive control, a sanity check, and
the actual negative assertion — never a vacuous one.

- [ ] 8.1 RED then GREEN (live): seed broker A and broker B, each with
      `extractions`, `renewals`, and `conversations` fixture rows, via the
      real magic-link + callback flow (not direct SQL for the session), then
      an authenticated broker-A session reads zero of broker B's
      `extractions` via the real review-queue endpoint — **with a positive
      control** confirming broker A's own rows ARE visible in the same call.
      Traces to proposal Success Criteria "Non-negotiable: a live test
      proves an authenticated broker A session cannot read broker B's
      extractions, renewals, or metrics" and broker-auth/extraction-review
      spec scoping requirements.
- [ ] 8.2 RED then GREEN (live): same two-broker fixture, broker A's session
      reads zero of broker B's `renewals` via the renewal-status metrics
      endpoint, with the same positive-control structure.
- [ ] 8.3 RED then GREEN (live): same fixture, broker A's session reads zero
      of broker B's data across all six metric endpoints in one sweep, with
      positive controls for each. Traces to product-metrics spec "Broker A's
      metrics never include Broker B's rows".
- [ ] 8.4 RED then GREEN (live): the full login journey end-to-end — a
      seeded `broker_users` row with an email requests a link via the real
      route, the real (test-double) email client captures the dispatched
      URL, the callback is called with that URL's token, and the resulting
      session cookie authenticates a subsequent real request to
      `GET /api/auth/me`. Traces to proposal Success Criteria "A
      `broker_users` row with an email can request a link, receive it,
      click it, and land authenticated in the dashboard."
- [ ] 8.5 Confirm (structural, cross-cutting): grep/inspect every route file
      under `apps/api/src/routes/auth/*` and `apps/api/src/routes/dashboard/*`
      for a Zod input schema and assert none declares `brokerId` — a
      repo-wide version of Phase 4's per-route check (4.14), run once more
      here as the final cross-cutting gate before sign-off. Traces to
      proposal Success Criteria "Non-negotiable: no dashboard endpoint
      accepts brokerId from the client. Verifiable by inspection of every
      route's input schema."
- [ ] 8.6 Record the O5 disposition explicitly in this change's notes:
      `admin-auth.ts` and `ADMIN_API_TOKEN` are **unchanged** (design D-D,
      "admin-auth.ts is untouched (O5)"); `/admin/policies/import` does
      **not** move behind the session in this change. Confirm via a
      regression run of A1's existing `apps/api/src/middleware/admin-auth.ts`
      tests that nothing in Phases 1-7 altered that file or its env var.
- [ ] 8.7 Run `pnpm -r typecheck` and `pnpm -r test` from a clean state;
      cross-check every proposal Success Criteria checkbox (proposal.md,
      bottom) against completed tasks, following F2's Phase 6.8 / A1's Phase
      7.4 precedent for documenting any item unconfirmed in this environment
      (no live Postgres reachable) rather than silently checking boxes.
- [ ] 8.8 Update `openspec/ROADMAP.md` and `openspec/PHASES.md` to remove
      C1's `(ff)` tag and record phase state, per proposal's Affected Areas
      table and Success Criteria "ROADMAP.md C1 no longer claims (ff)".

**No password/OAuth/SSO/MFA suite in this phase, by design.** Proposal Out
of Scope states magic-link-only auth; inventing a broader auth-method test
matrix here would test a scenario this change's own design explicitly does
not support.
