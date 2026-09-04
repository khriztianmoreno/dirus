# Verify Report: `whatsapp-webhook-ingress` (F2)

**Verdict: PASS**

**Mode**: Full artifact set (proposal, design, specs, tasks, apply-progress) —
completeness, correctness, and design coherence all verified, with runtime
evidence for both the offline suite (executed in this session) and the live
suites (CI run history, since no Postgres is reachable in this sandbox).

## What was checked

- Read exploration.md, proposal.md (incl. Product Decisions P1-P5), design.md
  (D-1 through D-7), `specs/webhook-ingress/spec.md` (9 requirements / 20
  scenarios), `specs/data-model/spec.md` (6 requirements / 18 scenarios),
  tasks.md (6 phases, 63 of 64 tasks checked — 4.8 deliberately deferred, see
  below), and the full `apply-progress.md` implementation log.
- Read every production file named in the task: `0004_tenant_resolver.sql`,
  `tenant-resolution.ts`, `app.ts`/`env.ts`/`index.ts`, `webhook-auth.ts`,
  `tenant-resolver.ts`, `routes/webhooks/chatwoot.ts`, `ingest-message.ts`,
  `packages/integrations/src/chatwoot.ts`, `packages/schemas/src/webhooks/chatwoot.ts`.
- Read both non-negotiable test files in full: `packages/db/test/migrations/live-tenant-resolution.test.ts`
  (481 lines) and `apps/api/test/live/webhook-ingress.live.test.ts` (449 lines).
- Ran `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm run lint`, `pnpm run lint:deps`
  in this environment (no live DB reachable — live suites correctly report
  SKIPPED, not passing).
- Confirmed CI run 33899572167 (Phase 1 gate) and CI run 33922648316 (Phase 6,
  final) both `conclusion: success` via `gh run view`.

## 1. Every spec requirement has a real, discriminating test

All 9 `webhook-ingress` requirements and all 6 `data-model` delta requirements
have covering tests that assert on behavior, not tautologies:

| Requirement | Test(s) | Discriminating? |
|---|---|---|
| Inbound Webhook Authentication | `webhook-auth.test.ts` (5/5, offline, ran) | Yes — asserts 401 + downstream spy never called |
| Tenant Resolution by wa_phone_number_id | `tenant-resolver.test.ts` (3/3, offline, ran); `live-tenant-resolution.test.ts` #1/#3 (CI green) | Yes |
| Idempotent Message Persistence | `ingest-message.live.test.ts` (sequential, CI-dependent); `webhook-ingress.live.test.ts` 6.1/6.2 (concurrent, `Promise.all`, CI green) | Yes — real concurrent dispatch, not sequential-looking-concurrent |
| Contact Find-or-Create | `ingest-message.live.test.ts` 5.10/5.11 | Yes |
| Conversation Find-or-Create (incl. concurrent) | `webhook-ingress.live.test.ts` 6.3/6.4 (CI green) | Yes — asserts exactly 1 `conversations` row + both messages reference it |
| Multi-Tenant Isolation (non-negotiable) | `webhook-ingress.live.test.ts` 6.6 (CI green) | Yes — real two-broker fixture seeded via the actual ingress path, asserts every returned row's `broker_id`, plus a non-vacuity sanity check (`contacts.rows.length > 0`) |
| Fixed Echo Reply | `chatwoot.test.ts` (integrations, 7/7 ran) + `chatwoot.test.ts` (route, 2 tests) | Yes — table includes a body that textually overlaps the fixed copy |
| Media Message Persistence | `ingest-message.no-media-fetch.test.ts` (2/2, ran, mutation-verified per apply-progress) + live 4th test (CI-dependent) | Yes |
| Raw Payload Is Not Retained Verbatim | `chatwoot.test.ts` (schemas, stripping tests against fixture's own extra key + synthetic fields) | Yes |
| data-model: resolver role NOLOGIN etc. | `live-tenant-resolution.test.ts` catalog checks (CI green) | Yes |
| data-model: policy TO-scoped to resolver only | Same file, catalog + **mutation test** dropping the `TO` clause (CI green) | Yes — mutation proves the guard discriminates, not just runs |
| data-model: negative control | Same file, assertion #2 (CI green) | Yes |
| data-model: EXECUTE revoked from PUBLIC | Same file, catalog check | Yes |
| data-model: membership never inheritable | Same file, assertion #5 + **mutation test** granting inheritable membership (CI green) | Yes |
| data-model: status not filtered (P5) | Same file, "suspended broker still resolves" (CI green) | Yes |

No spec scenario was found without a covering test.

## 2. The two non-negotiable properties — re-derived, not trusted

**`live-tenant-resolution.test.ts`**: The negative control (assertion #2) runs
`SELECT dirus_resolve_broker_id('phoneA')` then, in the *same* `pg.Client`
session/connection, immediately runs `SELECT count(*) FROM brokers` and
`SELECT * FROM brokers`, asserting both return zero. This is a real same-
session proof, not a fresh-connection approximation. It is backed by an owner
control (assertion #4, a structurally identical function owned by the table
owner, proven to return `NULL`) and **two executed mutation tests**: one drops
the policy's `TO` clause and asserts the negative control would then fail
(count > 0); the other grants an inheritable membership and asserts the
membership-guard query then reports it. Both mutations are real Postgres DDL
run against a live fixture in CI, not simulated. The gate is not vacuously
true.

**`webhook-ingress.live.test.ts`**: Concurrency tests 6.1/6.2 and 6.3/6.4 use
`Promise.all([post(app, payloadA), post(app, payloadB)])` where `post()`
returns the un-awaited `app.request(...)` promise — both HTTP requests are
issued before either settles, verified by reading the code (not
`await post(a); await post(b)`, which the file's own header explicitly
identifies as the anti-pattern that would pass against a broken
check-then-insert implementation). Row-count assertions are scoped to the
specific fixture each test created (`WHERE wa_message_id = $1`,
`WHERE conversation_id = $1`), not a broker-wide count that could pick up
unrelated seed rows — this is a lesson apply-progress.md documents as
CI-caught in Phase 5 and deliberately avoided here. The cross-tenant isolation
test (6.6) includes a non-vacuity sanity assertion
(`expect(contacts.rows.length).toBeGreaterThan(0)`), which is the correct
defense against an isolation test that "passes" only because it queried
nothing.

## 3. Success Criteria cross-check (proposal.md, independent re-check)

| Criterion | Status |
|---|---|
| Webhook resolves broker, persists one `messages` row with correct FKs | Implemented (`ingest-message.ts`); tested (sequential live + this phase's seed); CI green (33922648316) |
| Replay — sequential and concurrent — leaves one row, 2xx | Implemented (`ON CONFLICT DO NOTHING`); tested both ways; CI green |
| Unknown `wa_phone_number_id` rejected, no rows, no tenant inferred | `tenant-resolver.ts` — confirmed by an offline test that genuinely ran in this session (3/3) |
| Unsigned/unauthenticated request rejected | `webhook-auth.ts` — confirmed by an offline test that genuinely ran (5/5) |
| Non-negotiable: live isolation test | `webhook-ingress.live.test.ts` 6.6 — CI green (33922648316) |
| Live test: R1 mechanism does not expose arbitrary `brokers` rows | `live-tenant-resolution.test.ts` — CI green (33899572167), re-confirmed at the pipeline level by task 6.7 (also CI green) |
| `pnpm -r typecheck`/`test` pass; `packages/schemas` zero workspace deps | Re-run independently in this session: typecheck clean (9/9 projects), test clean (all pass or correctly-skip, matching apply-progress's reported counts exactly: `packages/db` 97/31 skip, `apps/api` 27/8 skip, `packages/integrations` 7/7), `packages/schemas/package.json` confirmed `dependencies: { zod }`, `devDependencies: {}` |

All 7 criteria independently verified, matching apply-progress's own task 6.8
cross-check.

## 4. Design decisions implemented as designed

- **D-1** (`0004_tenant_resolver.sql`): confirmed line-by-line against the
  data-model spec's requirements — `CREATE ROLE ... NOLOGIN NOSUPERUSER
  NOBYPASSRLS NOCREATEDB NOCREATEROLE`, `CREATE POLICY tenant_resolver_lookup
  ... FOR SELECT TO dirus_tenant_resolver USING (true)`, `SECURITY DEFINER`
  function with `SET search_path = ''` and schema-qualified `public.brokers`,
  `GRANT ... WITH INHERIT FALSE` before `OWNER TO`, `REVOKE ALL ... FROM
  PUBLIC` before the guarded `GRANT EXECUTE`. Matches exactly.
- **D-2** (`ingest-message.ts`): statement order confirmed exactly —
  `onConflictDoUpdate` on contacts (never `onConflictDoNothing`) first,
  conversation `SELECT` second, conditional `INSERT` third,
  `onConflictDoNothing` on messages fourth, all inside one
  `withBrokerContext` callback (structurally impossible to split into two
  transactions given `tenant.ts`'s reentrancy guard).
- **P1-P5** each have a backing test: P1 → `chatwoot.test.ts`'s table-driven
  echo-text test; P2 → the stripping tests in `packages/schemas`; P3 →
  `ingest-message.no-media-fetch.test.ts` (mutation-verified per
  apply-progress) + the live 4th test; P4 → `tenant-resolver.test.ts`'s
  log-content assertion (asserts both presence of `wa_phone_number_id` and
  absence of body/sender/content patterns); P5 → the "suspended broker still
  resolves" live assertion.

## 5. Disclosed gaps — confirmed still disclosed, not silently resolved

- **O3** (Chatwoot HMAC signing unconfirmed): `webhook-auth.ts`'s module
  docstring still states plainly "a compensating control, not a signature,"
  names the confirmation status as open, and the design's stated escape
  hatch (raw-body read, no `c.req.json()`) is present in the code. Not
  resolved into unwarranted confidence.
- **O4** (Chatwoot payload shape unconfirmed): `packages/schemas/src/webhooks/chatwoot.ts`'s
  module docstring still carries the `@provisional` marker, names both open
  unknowns (shape, resolution-key field), and states the fallback
  (`account.id`/`chatwoot_account_id`) if the current guess
  (`inbox.phone_number`) is wrong. Task 4.8, which would resolve this, is
  correctly left unchecked in `tasks.md` and explicitly flagged as
  "not scheduled" pending real payload confirmation.

Both are exactly where the proposal left them — genuine open items, not
defects.

## Task completeness

63 of 64 tasks checked `[x]`. The one unchecked task (4.8) is intentionally
deferred — it only fires once a real Chatwoot payload is captured (O4), and
`tasks.md` states this explicitly ("Not scheduled now"). This is not a gap;
attempting it now would mean guessing at an open confirmation rather than
resolving it. Not a CRITICAL or WARNING finding.

## Issues

**CRITICAL**: none.

**WARNING**: none.

**SUGGESTION**:
- Task 4.8 remains open pending a real Chatwoot payload capture — track this
  as a follow-up item for whenever Chatwoot integration testing begins (O4).
  Not a defect in this change; flagged for continuity only.
- O3 (Chatwoot HMAC support) remains unconfirmed. `apply-progress.md`/design
  D-4 already state the upgrade path is local to `webhook-auth.ts` if this
  is later confirmed. No action needed for this change to be considered done.

## Evidence log (this session)

- `pnpm -r run typecheck` — clean, all 9 workspace projects with a
  `typecheck` script.
- `pnpm -r run test` — `packages/db` 97 passed / 31 skipped (20 files, 5
  skipped-whole-file), `apps/api` 27 passed / 8 skipped (9 files, 2
  skipped-whole-file), `packages/integrations` 7/7, `packages/config`
  4/4-equivalent, `packages/schemas` clean, all other packages
  pass-with-no-tests. Zero unexpected failures. Matches apply-progress's own
  reported counts exactly.
- `pnpm run lint` — clean, no findings.
- `pnpm run lint:deps` — clean: "no dependency violations found (108
  modules, 248 dependencies cruised)".
- `gh run view 33899572167` — `conclusion: success` (Phase 1's D-1 gate:
  `live-tenant-resolution.test.ts` 14-17/17, all green in CI).
- `gh run view 33922648316` — `conclusion: success` (Phase 6, final: the
  full monorepo suite including `webhook-ingress.live.test.ts`'s concurrency
  and isolation tests, all green in CI).

## Final Verdict: PASS

Every spec requirement has a real, discriminating covering test. The two
non-negotiable properties (tenant isolation, idempotency-under-concurrency)
are proven by genuine negative controls, owner controls, and executed
mutation tests — not decorative assertions. Design decisions D-1 through D-7
match their implementation exactly, including load-bearing details (statement
order, `WITH INHERIT FALSE`, schema-qualified references, `DO UPDATE` vs `DO
NOTHING`). Both disclosed unknowns (O3, O4) remain honestly disclosed in the
shipped code, not silently resolved. All local build/test/lint evidence is
clean, and both critical CI runs referenced by the task are independently
confirmed green via `gh run view`. No CRITICAL or WARNING findings.
