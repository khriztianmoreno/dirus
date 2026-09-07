# Verify Report: admin-dashboard (C1)

**Date**: 2026-09-07
**Verifier**: sdd-verify
**Branch**: `feat/admin-dashboard` (PR #42, open, targets `main`)
**Commit verified**: `1afa8be` (all 8 phases, tasks.md fully checked)
**Mode**: OpenSpec (proposal/specs/design/tasks/apply-progress read directly from `openspec/changes/admin-dashboard/`)

## Command Evidence (executed in this session, not trusted from apply-progress.md)

| Command | Result |
|---|---|
| `pnpm -r run typecheck` | **8/8 packages/apps clean** |
| `pnpm -r run test` | **all offline suites green** — `apps/api`: 134 passed / 36 skipped (live, correctly gated on unset `*_TEST_DATABASE_URL`); `packages/db`: 134 passed / 59 skipped (same gating); `packages/integrations`: 9 passed; `apps/dashboard`: no test files (expected — Phase 7 shipped no component tests, only the manual client.ts) |
| `pnpm run lint` | clean, zero errors |
| `pnpm run lint:deps` | clean — "no dependency violations found (205 modules, 599 dependencies cruised)" |
| `gh run list --branch feat/admin-dashboard --limit 3` | latest push run (`34135779237`) at `headSha=1afa8be...` — **conclusion: success** |
| `git log --oneline -- apps/api/src/middleware/admin-auth.ts` | single commit `05fdfdb` (A1 phase 3) — **zero commits since**, `git diff 05fdfdb -- admin-auth.ts` is empty |
| `git status --short` | clean (only unrelated `.atl/` cache files, pre-existing) |

## Non-Negotiables — Individually Re-Verified From Source

1. **No dashboard/auth route Zod schema accepts client-supplied `brokerId`** — PASS. Grepped every schema file under `apps/api/src/routes/{auth,dashboard}` and `packages/schemas/src`. Only two request schemas exist in the entire session-relevant surface: `magicLinkRequestSchema` (pre-session, `{ email }` only) and `correctionRequestSchema` (`packages/schemas/src/dashboard/correction-request.ts`, only `{ correctedOutput }`, deliberately no `correctedBy` field — Zod strips unknown keys by default). `session-protected-schemas.ts` maintains a manual registry (`SESSION_PROTECTED_INPUT_SCHEMAS`) asserting no registered schema declares `brokerId`; confirmed the registry is **not vacuous** — it is the complete set (verified via `rg "safeParse|Schema\b"` across `routes/dashboard` and `routes/auth`: only `correctionRequestSchema` and `magicLinkRequestSchema` are ever parsed, and the registry's own test file includes a "poisoned schema" mutation-test proving the check mechanism actually fires). Every dashboard/metrics/review-queue/logout/me route reads `c.var.brokerId` exclusively, set by `session-auth.ts` from the resolved session.

2. **RLS is `FORCE ROW LEVEL SECURITY` with matching `USING`/`WITH CHECK`** — PASS. Read `packages/db/migrations/0006_broker_auth.sql` directly: `magic_link_tokens` and `sessions` both get `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a `tenant_isolation` policy with identical `USING`/`WITH CHECK` predicates (`broker_id = nullif(current_setting('app.broker_id', true), '')::uuid`). `broker_users` (touched, not newly created by 0006) already carries `FORCE ROW LEVEL SECURITY` from `0002_rls_policies.sql` (confirmed by direct read) — 0006 only adds the `email` column and a separate `tenant_resolver_lookup` policy scoped `TO dirus_tenant_resolver` only (does not weaken the existing `tenant_isolation` policy).

3. **Three `SECURITY DEFINER` resolver functions** — PASS. All three (`dirus_resolve_broker_id_by_{email,magic_link,session}`) have `SET search_path = ''`, schema-qualified `public.<table>` bodies, `LANGUAGE sql STABLE SECURITY DEFINER`, and each returns a bare `uuid` (`SELECT broker_id FROM ...`), never a row/record type — verified by reading the migration SQL directly, not design.md's prose description of it. `EXECUTE` is `REVOKE`d from `PUBLIC` and granted only to `dirus_app` (guarded by a `pg_roles` existence check for fresh-clone safety).

4. **CSRF uses `crypto.timingSafeEqual`, not `===`** — PASS. `apps/api/src/middleware/csrf-guard.ts` line 1 imports `timingSafeEqual` from `node:crypto`; `constantTimeEquals` does a length check first (required — `timingSafeEqual` throws on mismatched-length buffers) then calls `timingSafeEqual(providedBuf, expectedBuf)`. No `===` string comparison of secret values anywhere in the file.

5. **Session cookie attributes match design D-B exactly** — PASS. `apps/api/src/services/auth/session-cookies.ts`: `dirus_session=...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800` (`SESSION_COOKIE_MAX_AGE_SECONDS = 7*24*60*60 = 604800`); `dirus_csrf=...; Secure; SameSite=Lax; Path=/; Max-Age=604800` — identical minus `HttpOnly`, exactly as required so the SPA can read it (confirmed consumed in `apps/dashboard/src/api/client.ts`'s `readCookie`).

6. **Anti-enumeration: byte-identical 202 regardless of email existence** — PASS. `apps/api/src/routes/auth/magic-link.ts`: a single `ACCEPTED_BODY = { status: "accepted" }` / `ACCEPTED_STATUS = 202` literal is returned for a known email, an unknown-but-well-formed email, and a malformed body (Zod-failure path returns the *same* literal — a deliberate, well-documented deviation from design.md D-C's looser "400 on Zod failure" text, resolved in favor of the spec's stricter scenario, and explicitly flagged as a reconciliation note in the source rather than silently done). `test/routes/auth/magic-link.test.ts` (5 tests, all passing) backs this.

7. **`admin-auth.ts`/`ADMIN_API_TOKEN` untouched since A1** — PASS. `git log --oneline --all -- apps/api/src/middleware/admin-auth.ts` shows exactly one commit (`05fdfdb`, A1 phase 3); `git diff 05fdfdb -- apps/api/src/middleware/admin-auth.ts` is empty. Task 8.6's claim is correct.

8. **Cross-tenant isolation live test asserts real set-emptiness, not a vacuous check** — PASS. Read `apps/api/test/live/cross-tenant-isolation.live.test.ts` in full (565 lines). It drives a REAL end-to-end login (`POST /auth/magic-link` → captured test-double email URL → `GET /auth/callback`) through the real `createApp`, seeds broker A (small, distinct counts) and broker B (deliberately larger, overlapping status labels, different day-offsets) directly via the seeding superuser client, then asserts: (a) positive controls — broker A's own known fixture values ARE present (e.g. `paid: 1, pending: 1`, `flagged: 1, total: 2`), and (b) negative — broker B's specific seeded IDs/values (e.g. `extractionB1Id`, `paid: 4`, `pending: 3`, `escalated` status, `days: 99`) are explicitly asserted absent/wrong. This is a genuine discriminating proof: a real leak would produce a wrong count or an extra id, not silently pass an "array is defined" check. CI (`34135779237`, `headSha=1afa8be`) reports this suite green (it correctly SKIPs locally — no Postgres reachable in this environment — but ran for real in CI's service-container job).

## Spec Compliance Matrix

### broker-auth (9 requirements, all PASS)
| Requirement | Verified against |
|---|---|
| Magic-Link Request Endpoint | `magic-link.ts`, `issue-magic-link.ts` (hash-only storage, 15-min TTL) |
| Anti-Enumeration Response Is Indistinguishable | see non-negotiable 6 above |
| Token Is Never Stored Raw | `magic-link.ts`: `createHash("sha256")` before persist; raw token only in URL/memory |
| Token Consumption Is Single-Use | `consume-magic-link.ts`: atomic `UPDATE ... WHERE used_at IS NULL AND expires_at > now()` in one statement — no check-then-act race |
| Token Expiry Is Enforced Server-Side | same atomic UPDATE, `expires_at > now()` computed server-side |
| Session Established as httpOnly Signed Cookie With Sliding Expiry | `session-cookies.ts` + `touch-session.ts` (throttled refresh, `WHERE last_seen_at < now() - interval '15 minutes'`, atomic UPDATE) + `resolve-session.ts` (`revoked_at IS NULL AND idle_expires_at > now()`) |
| brokerId Is Never Accepted From the Client | see non-negotiable 1 above |
| Logout Invalidates the Session | `routes/auth/logout.ts` calls `revokeSession`; `test/routes/auth/logout.test.ts` (2 tests) passing |

### data-model (3 requirements, all PASS)
Verified directly against `0006_broker_auth.sql` and `packages/db/test/migrations/broker-auth-migration.test.ts` (16 tests, offline, passing): plain `CREATE UNIQUE INDEX` on `email` (not `NULLS NOT DISTINCT`, correctly allowing multiple `NULL`s), `magic_link_tokens` NOT NULL `broker_id`/`broker_user_id`, RLS as covered by non-negotiable 2.

### extraction-review (4 requirements, all PASS)
Verified against `routes/dashboard/review-queue.ts`, `services/queries/{needs-review-queue,correct-extraction}.ts`, `services/to-envelope.ts`. Double-filtering (SQL `WHERE needs_review = true` AND a route-level `.filter()`) is defense-in-depth, matches spec exactly. `correctExtraction` writes `correctedOutput`/`correctedBy`/`needsReview: false` in one atomic UPDATE scoped by both RLS and an explicit `broker_id` WHERE clause (belt-and-suspenders). `correctionRequestSchema` structurally cannot carry a client-supplied `correctedBy` (Zod strips unknown keys) — the route reads `c.var.session.brokerUserId` exclusively.

### product-metrics (5 requirements, all PASS)
Verified against `routes/dashboard/metrics.ts` and `services/metrics/*.ts`. Cost endpoint confirmed returning the disclosed-deferred shape `{ value: null, sampleSize: 0, empty: true, status: "deferred" }` (asserted live in `cross-tenant-isolation.live.test.ts` task 8.3, item 6) — never a fabricated number. All six metrics scoped exclusively via `c.var.brokerId` → `withBrokerContext`.

## Task Completeness

All 84 tasks across 8 phases in `tasks.md` are checked. Cross-checked against actual code state for every phase (not taken on trust) — no discrepancies found between checkbox state and what the source/tests actually do.

## Issues

### CRITICAL
None.

### WARNING
- `apps/dashboard` has zero component/route tests (`pnpm -r run test` reports "No test files found, exiting with code 0" for that workspace). Phase 7's scope (per apply-progress.md) was the SPA shell + reverse-proxy wiring, and the CSRF/session-cookie logic it depends on is covered from the API side, but the frontend's own `apiRequest`/`RequireSession`/route components have no direct test coverage. Not a spec violation (no spec requirement mandates frontend unit tests), but worth flagging before archive so it isn't lost.
- The live test suites (`session-lifecycle`, `magic-link-consumption`, `cross-tenant-isolation`, `metrics`, `review-queue`, `webhook-ingress`, `policies-import`) all correctly SKIP in this local environment (no reachable Postgres) — their pass/fail signal for this verify run comes entirely from the CI run confirmed green at `1afa8be`, not from a local execution. This is expected and matches the project's established convention (D-A's own documented environment constraint), not a defect.

### SUGGESTION
- None beyond what's already disclosed in apply-progress.md's own phase records (e.g. the documented design/spec reconciliation on the malformed-email 202 response, which was resolved correctly in favor of the spec).

## Verdict

**PASS**

All 8 non-negotiables were independently re-verified against actual source (migration SQL, middleware, route handlers, live test bodies) rather than taken from design.md's prose or apply-progress.md's self-report. All 22 spec requirements across the four spec files have corresponding, correct implementation and passing test coverage (offline where the test can run locally, CI-confirmed-green for every live/DB-backed assertion). `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm run lint`, and `pnpm run lint:deps` all pass cleanly from the current working tree. The latest CI run on `feat/admin-dashboard` at `1afa8be` is green. No CRITICAL findings. Two WARNINGs noted (frontend has no unit tests; live-suite pass signal is CI-sourced, not locally re-executed) — neither blocks archive. Ready for `sdd-archive`.
