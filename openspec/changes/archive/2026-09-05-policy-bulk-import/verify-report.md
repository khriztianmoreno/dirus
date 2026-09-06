# Verify Report: `policy-bulk-import` (A1)

**Verdict: PASS**

Independently re-derived, not taken on `apply-progress.md`'s self-report.
Verified against `main` at `cad5c23` (all 7 phases merged: PRs #33, #34, #35,
#36, #40, #38, #39), on branch `feat/policy-bulk-import-verify`.

## Summary

Every one of the 11 `policy-import` requirements (24 scenarios) and the 1
`data-model` requirement (4 scenarios) has a real, discriminating test. The
partial-index/`ON CONFLICT` bug and the consent-invariant test's two false
framings — both flagged by the task brief as defects CI actually caught — are
confirmed fixed in the committed code, not merely described as fixed. The
Phase 7 phone-fixture bug is confirmed fixed. All CI runs referenced below are
the *final* runs on each PR and are green, including every live-Postgres
suite this change wrote (0 skipped in the final runs — a stronger state than
`proposal.md`'s own Success-Criteria section discloses; see Finding 1).

## Evidence run in this environment

- `pnpm -r run typecheck` — all 8 workspace projects clean.
- `pnpm -r run test` — `packages/db` 103 passed/34 skipped, `packages/schemas`
  72/72, `packages/integrations` 7/7, `apps/api` 51 passed/24 skipped (every
  skip is a live suite gated on `LIVE_TEST_DATABASE_URL`, confirmed SKIPPED
  not erroring — no Postgres reachable in this sandbox).
- `pnpm run lint` — clean.
- `pnpm run lint:deps` — clean, "no dependency violations found (126 modules,
  317 dependencies cruised)".
- `packages/schemas/package.json` — `{ "zod": "^4.4.3" }` only, dependency
  rule intact.

## CI history — independently pulled via `gh`, not trusted from the proposal text

All 7 PRs merged with green `typecheck, lint, test` CI (real Postgres 17
service container, `dirus_test` DB — the `_test`/`_ci` throwaway-DB guard the
live tests themselves enforce is satisfiable in this workflow):

| PR | Phase | Final CI run | Live tests actually executed |
|---|---|---|---|
| #33 | 1 (migration) | 33971129508 | `live-policy-number-unique-index.test.ts` 3/3, `packages/db` 134/134, 0 skipped |
| #34 | 2 (row schema) | green | — |
| #35 | 3 (auth middleware) | green | — |
| #36 | 4 (guards) | green | — |
| #40 | 5 (import service, replaces closed #37) | 34007178019 | `import-policies.live.test.ts` 13/13, `apps/api` 64/64, 0 skipped |
| #38 | 6 (route) | 34007292483 | `policies-import.test.ts` 8/8 offline, `apps/api` 72/72 |
| #39 | 7 (live e2e, final) | 34007405952 | `policies-import.live.test.ts` 3/3, `apps/api` 75/75, 0 skipped |

**Finding 1 (informational, not a defect):** `proposal.md`'s Success Criteria
section (written during Phase 7, before any of these CI runs happened)
discloses 7 of 9 criteria as "UNCONFIRMED, pending CI." That disclosure is now
stale — CI has since run green with 0 skips across every phase's live suite,
per the run logs pulled above. This is a correct-at-the-time disclosure, not
a defect in the change, but the artifact itself is out of date relative to
its own repo's CI history. Worth a follow-up edit before archive so a future
reader doesn't need to re-pull CI logs to learn this is actually fully
confirmed.

## The three CI-caught bugs — confirmed fixed in committed code

1. **Partial-index `ON CONFLICT` arbiter mismatch** (`ad9f123`). CI's first
   run of Phase 5's live suite failed 4 tests with Postgres error 42P10 ("no
   unique or exclusion constraint matching the ON CONFLICT specification").
   Confirmed the fix is in the committed code: `import-policies-writer.ts`'s
   `upsertPolicy` `onConflictDoUpdate` call carries
   `targetWhere: sql\`${schema.policies.policyNumber} is not null\`` (line
   211), matching `0005_policy_number_unique_index.sql`'s own `WHERE
   policy_number IS NOT NULL` predicate verbatim. The migration file itself
   still declares the partial index correctly (no `NULLS NOT DISTINCT`,
   `WHERE "policies"."policy_number" IS NOT NULL` present) — confirmed by
   reading the file directly, not by trusting the structural test.
2. **Consent-invariant test — two wrong framings, then the correct one**
   (`ad9f123`, `6a376d0`). Read `import-policies.live.test.ts`'s 5.11/5.12
   test in full: it does NOT search query text for the column name
   `consent_at` (the first two framings, proven wrong by drizzle-orm's
   `buildInsertQuery` listing every column on every INSERT regardless of
   correctness — documented in the test's own docstring, lines 307-353). The
   final, committed assertion checks whether the adversarial CSV's
   consent-looking VALUES (`"true"`, `"2026-01-01"`) ever appear as a BOUND
   PARAMETER on an INSERT/UPDATE statement (lines 398-405), with a positive
   control confirming the spy actually observed real contact-insert traffic
   (lines 372-376) so the negative assertion isn't vacuous. This is the
   correct test for the invariant and is what's committed, not a reverted
   intermediate version.
3. **Phone-fixture hex-vs-digits bug** (`492a80c`). CI's first Phase-7 run
   failed 7.1/7.2 with `failed: 1` instead of `inserted: 1`, because
   `randomBytes(3).toString("hex")` can emit `a-f`, which `phoneSchema`'s
   `^\+?\d{7,15}$` correctly rejects. Confirmed the fix is committed:
   `policies-import.live.test.ts`'s `randomDigits()` (lines 111-113)
   generates a digits-only suffix via `Math.floor(Math.random() * 10)`, and
   is the function actually used by every phone-generating call site in the
   file. No production code was touched by this fix, correctly — the
   validation was doing its job on a bad fixture.

**Documentation gap worth flagging:** none of these three fixes are narrated
in `apply-progress.md` — that file's Phase 5 and Phase 7 sections both end
declaring the suites "written... UNCONFIRMED pending CI" and were never
updated after the CI round-trips happened. The fix commits' own messages
(`ad9f123`, `6a376d0`, `492a80c`) are thorough and accurate — better,
individually, than the phase log — but `apply-progress.md` as a single
artifact undersells the change's actual, now-fully-green state. This mirrors
`whatsapp-webhook-ingress`'s own verify report calling out its artifact's
merge/documentation quality independently of code correctness. Not a
CRITICAL — the code and tests are correct and CI-proven — but a WARNING for
archive hygiene: `apply-progress.md` should get a closing addendum noting the
three post-merge fixes before this change is archived, so the historical
record doesn't read as "still pending" when it is, in fact, done and green.

## Requirement-by-requirement trace

### `policy-import` spec (11 requirements, 24 scenarios)

| Requirement | Code | Test(s) that would fail on regression |
|---|---|---|
| Admin Token Authentication | `admin-auth.ts` | `admin-auth.test.ts` (5 tests: missing/wrong-length/wrong token → 401 empty body + next() never called via spy; correct token → next() called) + live `policies-import.live.test.ts` 7.3 (401 + zero DB rows via direct count query, not status alone) |
| Multipart Request Shape | `import-policies.ts::runImportGuards` | `import-policies.test.ts` (missing brokerId → 400 naming field) |
| — unknown brokerId (404 + structured log) | `runImportGuards` + `broker-existence.ts` | `import-policies.test.ts` (404, `resolveBrokerExists` fake, `console.error` spy asserting exact args + negative-match on file content) |
| Request Size Bounded | `runImportGuards`, `MAX_IMPORT_FILE_SIZE_BYTES`/`MAX_IMPORT_ROW_COUNT` | `import-policies.test.ts` (>5MB rejected before parse; 5,001 rows rejected with `policyImportRowSchema.safeParse` spy asserting `not.toHaveBeenCalled()` — proves ordering, not just outcome) |
| Row Validation Per-Row | `importPolicyRows` per-row loop | `policies-import.test.ts` 6.1 (3 valid + 1 invalid → `totals.failed=1`, other rows have `policyId`/`contactId`) + live 5.4 |
| — missing required header | `runImportGuards` + `REQUIRED_HEADERS` derived from schema | `import-policies.test.ts` (missing `endDate` header → 400 naming it, before any row touched) |
| Contact Find-or-Create Fills Blanks Only | `upsertContact`'s `COALESCE`-first-arg upsert | live 5.6 (create), 5.7 (blank doesn't erase), 5.8 (differing doesn't overwrite), 5.9 (null gets filled) — four separate scenarios, not folded together |
| Import Never Writes `contacts.consent_at` | `upsertContact` (no `consentAt` key anywhere in `.values()`/`.set()`) | live 5.11/5.12 — bound-parameter assertion (see bug #2 above), plus end-state NULL check |
| Idempotent Policy Upsert | `upsertPolicy`'s `onConflictDoUpdate` + partial-index `targetWhere` | live 5.13 (insert), 5.14 (unedited re-import → 0 inserted, N updated), 5.15 (edited re-import → 1 row, new value) |
| — policy_number/contact mismatch fails the row | `upsertPolicy`'s pre-upsert `SELECT` + `RowImportError` | live 5.17 (mismatch fails row, existing policy's `contact_id` unchanged, other rows unaffected) |
| Rows Without policy_number Are Honestly Non-Idempotent | `upsertPolicy`'s unconditional `INSERT` branch + `NON_IDEMPOTENT_ROW_WARNING` | live 5.19 (always inserts, warning present), 5.20 (re-import duplicates, both flagged) |
| Import Never Deletes/Reconciles | no delete/reconcile code path exists (structural) | live 5.22 (POL-2 untouched when only POL-1 re-imported) |
| Response Reports Per-Row Outcome + Totals | `importPolicyRows`'s totals reducer + route's `c.json(result, 200)` | `policies-import.test.ts` 6.1 (shape), 6.3 (200 regardless of row failures, mutation-tested by temporarily flipping to 422 and confirming both tests catch it) |
| Import Runs Within withBrokerContext / RLS | single `withBrokerContext` call + `tx.transaction` nesting | code-inspection (task 5.24, confirmed below) + live 7.1 (two brokers via real route, RLS-scoped read sees only own rows, positive control + non-vacuous sanity check) |

### `data-model` spec (1 requirement, 4 scenarios)

| Scenario | Evidence |
|---|---|
| Two same-`(broker_id, policy_number)` inserts rejected | live `live-policy-number-unique-index.test.ts` (unique-violation, one row survives) |
| Multiple NULL-`policy_number` rows for same broker permitted | live, same file — the non-collision proof, the actual point of the partial index |
| Same `policy_number` across different brokers permitted | live, same file |
| Committed migration SQL encodes partial index, not plain/NULLS-NOT-DISTINCT | structural `policy-number-unique-index.test.ts` (offline, reads the SQL file's text) + my own direct read of `0005_policy_number_unique_index.sql` confirming `WHERE "policies"."policy_number" IS NOT NULL` present and `NULLS NOT DISTINCT` absent |

## Specific checks requested

1. **Partial index + matching `ON CONFLICT` predicate** — confirmed, both in
   the migration file and in `upsertPolicy`'s `targetWhere`. See above.
2. **Consent invariant test checks the right thing** — confirmed: bound
   parameters, not column-name text. See bug #2 above.
3. **Transaction nesting (5.24)** — confirmed: `importPolicyRows` calls
   `withBrokerContext(brokerId, ...)` exactly once (line 264); each row is
   wrapped in `tx.transaction((rowTx) => processRow(rowTx, brokerId,
   parsed.data))` (line 277) — a real Postgres `SAVEPOINT` via drizzle's
   nested-transaction primitive, not a second `withBrokerContext` call. No
   second `withBrokerContext` invocation exists anywhere in the file.
4. **Cross-tenant isolation, end-to-end (7.1)** — confirmed: both brokers
   seeded via `app.request("/admin/policies/import", ...)` (real HTTP
   dispatch, never raw SQL for contacts/policies — only broker provisioning
   is raw SQL, out-of-band). Positive control: `admin` bypass-connection
   query proves broker A's rows exist (`count > 0`) before claiming anything
   about visibility. Sanity check against a vacuous negative: broker B's own
   `APP_ROLE`-scoped session asserts its OWN rows ARE visible
   (`length > 0`) in the same block that asserts none of broker A's rows leak
   in — a bug that returned zero rows for everyone would still pass a bare
   "no broker A rows" check without this.
5. **Success Criteria cross-check, independently redone** — every one of the
   9 bullets in `proposal.md` maps to real, existing code and a real,
   existing test. Per Finding 1 above, CI has since run every one of them
   green (0 skips in the final PR runs), which is stronger than the
   proposal's own "2 of 9 confirmed" self-assessment written before those
   runs happened.
6. **Habeas Data invariant, no code path writes `consent_at`** — confirmed by
   reading `upsertContact` (the only function that touches `contacts`) in
   full: its `.values()` and `.onConflictDoUpdate({ set: ... })` both
   enumerate exactly `fullName`/`docType`/`docNumber` plus the upsert key
   columns — `consent_at` appears in neither, under any row shape, including
   the no-`policyNumber` branch (that branch only affects `upsertPolicy`,
   which never touches `contacts` at all).
7. **`openspec/ROADMAP.md`'s A1 entry** — confirmed corrected. Current text:
   "requires a schema change... idempotent upsert by `(broker_id,
   policy_number)` is impossible without a new migration adding a partial
   unique index... shipped in this change's Phase 1," while preserving the
   true half of the original claim (tables themselves weren't missing). This
   matches task 7.5's description exactly.

## Findings

- **Finding 1 (WARNING, archive-hygiene)**: `apply-progress.md` is stale
  relative to this change's own CI history — it still reads as "written,
  unconfirmed" for suites CI has since run fully green with the fixes
  documented only in commit messages. Recommend a short closing addendum to
  `apply-progress.md` before archiving, cross-referencing the three fix
  commits (`ad9f123`, `6a376d0`, `492a80c`) and the final green CI runs
  listed above.
- **Finding 2 (SUGGESTION, non-blocking)**: task 5.12's mutation-testing pass
  (temporarily adding `consentAt: row.consent` to `upsertContact` to confirm
  the 5.11 test actually fails) is still marked "never run in any
  environment" as of `apply-progress.md`'s text, and there is no evidence in
  CI logs that it was performed either (CI only ran the suite as committed,
  never a mutated variant). This is low-risk: `PolicyImportRow` has no
  `consent`/`acepta_terminos` field, so the vulnerable data-flow path
  literally does not exist in the type system today, and the test's
  reasoning (checked directly, see requirement trace above) is sound by
  independent code reading. Still, the mutation pass itself remains an
  unexecuted verification step and should be run once, by hand, before this
  is fully trusted as a proven regression guard rather than a
  reasoned-through one.
- No CRITICAL issues found. No spec requirement is untested, unimplemented,
  or contradicted by the committed code.

## Recommendation

Proceed to `sdd-archive`. The two findings above are non-blocking (archive
hygiene + one still-unexecuted-but-low-risk manual verification step), not
regressions or gaps in the shipped behavior.
