# Tasks: Policy bulk import

## Ordering constraint — read before touching anything below

**Phase 1 is the migration plus its live proof, and nothing else.** The
partial unique index `policies (broker_id, policy_number) WHERE
policy_number IS NOT NULL` is the mechanism every later phase's idempotency
claim depends on (proposal P5, spec "Idempotent Policy Upsert Keyed on
(broker_id, policy_number)", data-model delta "Partial Unique Index on
Numbered Policies"). Unlike F2's D-1 gate, there is no unproven mechanism
here — `withBrokerContext` is already proven and reused as-is — so this is
not a "NEEDS EMPIRICAL PROOF" gate in the F2 sense. It is still sequenced
first because:

- The row-schema (Phase 2), the import service (Phase 5), and every live
  test asserting "re-import updates, does not duplicate" (Phase 7) are
  meaningless to write against a `policies` table that cannot yet
  distinguish "same policy" from "new policy" — there is nothing to upsert
  *on* until the index exists.
- The data-model delta spec's own scenario ("The committed migration SQL
  encodes a partial index, not a plain or NULLS-NOT-DISTINCT one") is a
  structural assertion on the migration file itself and has zero
  dependencies on anything else in this change — it is free to do first.

**Do not parallelize Phase 1 with Phase 5, 6, or 7.** Phases 2, 3, and 4 have
no dependency on Phase 1 (row schema, auth middleware, and multipart/size
handling touch neither `policies` nor its index) and MAY run in parallel
with Phase 1 or with each other. Phase 5 (the import service) is the first
phase that writes to `policies` and therefore depends on Phase 1's migration
being applied, plus Phases 2-4 for its inputs (row schema, authenticated
request, parsed rows). Phase 6 depends on Phase 5. Phase 7 depends on
Phase 6.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 700-1000 (migration + live test, row schema, admin-auth middleware, multipart/size-guard handling, import service, route, live integration tests) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Optional — one PR is plausible given the smaller scope, but a two-PR split (Phase 1 alone, then Phases 2-7) keeps the migration reviewable in isolation |
| Suggested split | PR 1 (Phase 1 gate) -> PR 2 (Phases 2-7) |
| Delivery strategy | ask-on-risk |

## Flagged dependencies on open questions (O1, O4)

Stated once here rather than repeated at every task site:

- **O1 (exact column contract) is unresolved** — no real broker spreadsheet
  exists. Every task touching the row schema (Phase 2) or the required-header
  rejection (Phase 4) implements against the schema's own `NOT NULL`-derived
  required set only: `insurer`, `line`, `end_date`, and a contact phone.
  Everything else in the row schema is optional. This is not a guess dressed
  up as a decision — it is explicitly provisional per proposal O1, and the
  row schema file must carry a `NEEDS CONFIRMATION` docstring marker saying
  so, per the house convention established in `extraction-schemas`.
- **O4 (CSV/XLSX library choice) is unresolved and has no architectural
  stakes** — proposal P7 says pick during apply. Task 5.1 below is where
  that pick happens; it is called out again at that task rather than
  guessed here.

## Phase 1: Migration + live proof — proposal P5, spec "Idempotent Policy Upsert", data-model delta "Partial Unique Index on Numbered Policies"

- [x] 1.1 RED: `packages/db/test/migrations/policy-number-unique-index.test.ts`
      (new file, sibling to `partial-indexes.test.ts`'s convention) —
      structural assertion reading the migration SQL file's text before it
      exists: asserts the file will contain `CREATE UNIQUE INDEX` on
      `policies (broker_id, policy_number)`, a `WHERE policy_number IS NOT
      NULL` clause verbatim, and does NOT contain `NULLS NOT DISTINCT`.
      Traces to data-model delta spec, scenario "The committed migration SQL
      encodes a partial index, not a plain or NULLS-NOT-DISTINCT one".
- [x] 1.2 GREEN: `packages/db/migrations/0005_policy_number_unique_index.sql`
      (`drizzle-kit generate --custom`, following 0004's precedent) —
      `CREATE UNIQUE INDEX ... ON policies (broker_id, policy_number) WHERE
      policy_number IS NOT NULL`. Update
      `packages/db/src/schema/policies.ts`'s Drizzle table definition to
      declare the same index (mirroring the existing partial index pattern
      already on this table for `(broker_id, end_date) WHERE status =
      'active'`) so `drizzle-kit`'s drift check (`drift.test.ts`) stays
      green. Satisfies 1.1. Traces to proposal P5.
- [x] 1.3 Write the down path (`DROP INDEX`) as a committed script or
      comment block, per proposal's Rollback Plan ("The index is additive;
      dropping it cannot lose data, only permit duplicates that did not
      exist before").
- [x] 1.4 RED then GREEN: extend `packages/db/test/migrations/drift.test.ts`
      (or confirm it already covers new indexes generically) so the new
      Drizzle schema index and the committed SQL migration cannot drift
      apart silently.
- [x] 1.5 Create
      `packages/db/test/migrations/live-policy-number-unique-index.test.ts`,
      extending `live-rls-verification.test.ts`'s established conventions
      exactly (`describe.skipIf(!LIVE_TEST_DATABASE_URL)`, throwaway schema,
      disposable fixture broker rows) — do not invent a new convention.
      Implements, each as its own `it()`:
      1. **RED then GREEN**: a second `INSERT` with the same
         `(broker_id, policy_number)` as an existing row is rejected with a
         unique-violation error, and exactly one row exists afterward.
         Traces to data-model delta scenario "Two policies with the same
         policy_number for the same broker are rejected".
      2. **RED then GREEN — the non-collision proof, the whole point of the
         partial index**: two sequential `INSERT`s with
         `(broker_id = B, policy_number = NULL)` for the SAME broker both
         succeed, and exactly two distinct `policies` rows exist for that
         broker with `policy_number IS NULL` afterward. This is the
         assertion that proves the index is a *partial* index and not a
         plain unique index that happens to pass every test which always
         supplies a `policy_number` — write it explicitly, do not fold it
         into a generic "insert succeeds" test that could pass by accident.
         Traces to data-model delta scenario "Multiple policies with a NULL
         policy_number for the same broker are permitted".
      3. **RED then GREEN**: the same `policy_number` value inserted for two
         different brokers succeeds for both. Traces to data-model delta
         scenario "The same policy_number is permitted across different
         brokers".
- [x] 1.6 Run the Phase 1 test suite against CI's live Postgres service
      container. This is the acceptance gate for Phase 1: if 1.5's
      non-collision assertion (item 2) fails, STOP — do not proceed to
      Phase 5, 6, or 7. A failure here means the index shape is wrong, not
      that a downstream test is wrong.
      **PASSED** — PR #33, CI run 33971024945: `live-policy-number-unique-index.test.ts`
      3/3, `packages/db` 134/134 across 22 files, zero skipped. All three
      live assertions (collision, NULL-vs-NULL non-collision, cross-broker)
      executed against a real server on the first CI run.

**Blocked on open question**: none. Phase 1 is self-contained.

## Phase 2: Row schema — proposal Approach/P7, spec "Row Validation Is Per-Row, Not Whole-File" (may run in parallel with Phase 1, 3, 4)

- [x] 2.1 RED: `packages/schemas/test/policy-import-row.test.ts` — a row
      missing any of `insurer`, `line`, `end_date`, or a contact phone fails
      validation naming the missing field. Write against the not-yet-written
      schema. Traces to O1's resolved required set (proposal O1, "insurer,
      line, end_date and a contact phone... are NOT NULL in the schema and
      therefore required").
      **RED confirmed**: before `src/policy-import-row.ts` existed, the
      suite failed with "Failed to load url ../src/policy-import-row.js" —
      module-not-found, not a stale-assertion false negative.
- [x] 2.2 RED: same file — every other recognized column
      (`policy_number`, `plate`, `premium_amount`, `currency`,
      `commission_pct`, `start_date`, `full_name`, `doc_type`, `doc_number`)
      is optional-on-presence: a row omitting them still validates.
      **RED confirmed** for the same reason as 2.1 (single test file, single
      not-yet-created module).
- [x] 2.3 RED: same file — strict-on-shape per the house convention
      (`extraction-schemas`): a row whose `end_date` is not a valid date, or
      whose phone is not a plausible phone shape, fails with a field-named
      error. Reuse `packages/schemas/src/primitives.ts`'s existing
      primitives (`isoDateSchema`, etc.) rather than inventing new date/phone
      validation — check `primitives.ts` for a reusable phone primitive
      first; if none exists, add one there rather than inlining ad hoc
      regex in the row schema.
      **RED confirmed** for the same reason as 2.1. No phone primitive
      existed in `primitives.ts`; added `phoneSchema` there (optional `+`,
      7-15 digits, E.164-shaped) plus `commissionPctSchema` (numeric(5,2)
      shape, mirroring `copAmountSchema`'s numeric(14,2) precedent) rather
      than inlining regexes in the row schema.
- [x] 2.4 GREEN: `packages/schemas/src/policy-import-row.ts` — the Zod row
      schema, satisfying 2.1-2.3. Carries a docstring stating the required
      set is provisional (`NEEDS CONFIRMATION`, O1) pending a real broker
      spreadsheet, following `caratula.ts`'s existing docstring convention
      exactly ("optional on presence, strict on shape... see primitives.ts").
      Re-export from `packages/schemas/src/index.ts`.
- [x] 2.5 Verify `pnpm --filter @dirus/schemas test` passes and
      `packages/schemas/package.json` still declares zero dependencies but
      `zod` (dependency rule, unchanged by this phase).
      **Verified**: 72/72 tests pass (15 new), `pnpm -r typecheck` clean,
      `pnpm run lint` clean, `pnpm run lint:deps` clean (112 modules, 263
      dependencies, zero violations), `package.json` dependencies unchanged
      (`{ "zod": "^4.4.3" }` only).

**Flagged — depends on O1**: 2.1-2.4's required/optional split can only be
pinned down fully once a real broker file exists; this phase implements the
schema's own NOT-NULL-derived minimum and marks the rest provisional rather
than guessing at broker-specific column names.

## Phase 3: Admin-token auth middleware — proposal P2, spec "Admin Token Authentication" (may run in parallel with Phase 1, 2, 4)

- [x] 3.1 RED: `apps/api/src/env.ts` test — extend the existing
      `readRequired`-pattern test (Phase 3 of F2's precedent) to assert
      `ADMIN_API_TOKEN` throws at import time when absent. Write before the
      env var is added.
- [x] 3.2 GREEN: add `ADMIN_API_TOKEN` to `apps/api/src/env.ts` and
      `.env.example`, satisfying 3.1.
- [x] 3.3 RED: `apps/api/src/middleware/admin-auth.ts` test — a request
      missing the `X-Dirus-Admin-Token` header, or presenting a
      wrong-length/incorrect token, is rejected with 401 and an empty body,
      and — critically — nothing downstream runs (assert via a spy/counter
      on a fake next-handler, mirroring `webhook-auth.ts`'s test
      convention). Traces to spec scenario "Request without a valid admin
      token is rejected with 401 and writes nothing".
- [x] 3.4 RED: same file — a request with the correct token passes through.
      Traces to spec scenario "Request with a valid admin token proceeds to
      parsing".
- [x] 3.5 GREEN: `apps/api/src/middleware/admin-auth.ts` — mirrors
      `webhook-auth.ts` exactly: fixed-length (>=32 byte) secret,
      `crypto.timingSafeEqual` after a length check, header only (no
      path-segment fallback — proposal P2 names only a header, unlike F2's
      webhook token which also accepts a path segment for a Chatwoot
      constraint that does not apply here), 401 with empty body on failure.
      One file, no auth logic in the route or service (proposal P2's
      one-file-swap constraint for C1's future replacement). Satisfies
      3.3-3.4.
- [x] 3.6 Verify `pnpm --filter @dirus/api typecheck` passes with the new
      middleware in place but not yet wired into any route (wiring happens
      in Phase 6).

## Phase 4: Request-shape and size-limit handling — proposal O2 (resolved)/P3, spec "Multipart Request Shape", "Request Size Is Bounded Before Parsing Begins" (may run in parallel with Phase 1, 2, 3)

- [x] 4.1 RED: request-shape test (offline, against a handler stub or the
      eventual route module with fakes injected, following `app.ts`'s
      `createApp({ ... })` offline-testability convention) — a multipart
      request with a `file` field but no `brokerId` field is rejected 4xx,
      naming `brokerId` as missing, before any row is parsed.
      Traces to spec scenario "Missing brokerId is rejected as a file-level
      error".
      **RED confirmed**: before `apps/api/src/services/import-policies.ts`
      existed, the whole suite failed with "Failed to load url
      ../../src/services/import-policies.js" — module-not-found, not a
      stale-assertion false negative (same convention as Phase 2's 2.1).
- [x] 4.2 RED: same suite — a request whose `file` field exceeds 5 MB is
      rejected 4xx naming the size limit, with the row-parsing function
      (inject as a fake/spy) never invoked. Traces to spec scenario "A file
      exceeding the size limit is rejected before parsing", proposal O2
      (resolved: 5 MB, enforced before parsing).
      **RED confirmed** for the same reason as 4.1 (single test file,
      single not-yet-created module).
- [x] 4.3 RED: same suite — a well-formed file with 5,001 data rows is
      rejected 4xx naming the row-count limit, with no row upserted. Since
      the row-count check necessarily requires the file to be parsed enough
      to count rows, assert this check runs and rejects *before* any row is
      individually Zod-validated or reaches the import service (i.e. the
      count-then-reject step is structurally separate from the per-row
      loop) — inject a spy on the per-row validation/upsert path and assert
      it is never called. Traces to spec scenario "A file exceeding the
      row-count limit is rejected before any row is upserted", proposal O2.
      **RED confirmed** for the same reason as 4.1. Ordering proven via
      `vi.spyOn(policyImportRowSchema, "safeParse")` (the actual, real
      export from `@dirus/schemas` — not a stand-in) asserted
      `not.toHaveBeenCalled()` after submitting 5,001 rows, not merely that
      the response is eventually a 4xx.
- [x] 4.4 GREEN: implement the size guard (`Content-Length`/buffer-size
      check) and the row-count guard (post-parse, pre-validation count
      check) as a single reusable function or pair of functions in
      `apps/api/src/services/import-policies.ts` (or a small dedicated
      module if that file is getting large — decide at implementation time),
      satisfying 4.1-4.3.
      **Done**: one function, `runImportGuards`, plus a private
      `splitCsvLines` guard-only line splitter (explicitly documented as
      NOT Phase 5's real CSV/XLSX parser — only enough to count rows and
      read header names for these guards).
- [x] 4.5 RED: unknown-`brokerId` test (this one needs `withBrokerContext`
      or an equivalent broker-existence check, so may be more naturally
      placed as an offline test against a fake broker-lookup function
      injected the same way `app.ts` injects `resolveBrokerId` for F2) — a
      `brokerId` that does not resolve to an existing broker returns 404,
      writes nothing, and emits exactly one structured log line
      (`policy_import_unknown_broker`, `{ brokerId }`) containing only the
      `brokerId` — assert via a spy on `console.error` (or whatever logger
      is in use) that the call args contain no file content or row data.
      Traces to spec scenario "Unknown brokerId is rejected before any row
      is processed", proposal Round 2 O3 (resolved: 404 + structured log).
      **RED confirmed** for the same reason as 4.1. `resolveBrokerExists`
      is an injected fake (mirrors `tenant-resolver.ts`'s
      `ResolveBrokerId` convention exactly) — no `@dirus/db` import
      reachable from this test's import graph.
- [x] 4.6 GREEN: implement the broker-existence check and its log line,
      satisfying 4.5.
      **Done**: `console.error("policy_import_unknown_broker", { brokerId })`
      — one structured argument, mirroring `tenant-resolver.ts`'s
      `tenant_resolution_miss` line exactly. Test asserts
      `toHaveBeenCalledWith` the exact args AND a negative-match assertion
      (logged text contains none of the fixture's file content/row values).
- [x] 4.7 RED: same suite — a file whose header row omits a required column
      (e.g. `end_date`) is rejected 4xx wholesale, naming the missing
      header, with no row written for any row in the file. Traces to spec
      scenario "A file missing a required header is rejected wholesale".
      **RED confirmed** for the same reason as 4.1.
- [x] 4.8 GREEN: implement the required-header check against Phase 2's row
      schema's required-field set, satisfying 4.7.
      **Done**: `REQUIRED_HEADERS` is derived from
      `Object.entries(policyImportRowSchema.shape).filter(([, f]) =>
      !f.isOptional())` — imported directly from `@dirus/schemas` (Phase
      2's real schema), never a hardcoded duplicate list. If Phase 2's
      schema and this check ever drift, the import itself breaks (a
      missing export or a type error), not a silent disagreement.

**Flagged — depends on O1**: 4.7-4.8's "required header" set is exactly
Phase 2's provisional required set (`insurer`, `line`, `end_date`, phone) —
not independently guessed here.

## Phase 5: The import service — proposal Approach/P4/P5/P6, spec "Row Validation Is Per-Row", "Contact Find-or-Create Fills Blanks Only", "Import Never Writes contacts.consent_at", "Idempotent Policy Upsert...", "Rows Without policy_number Are Honestly Non-Idempotent", "Import Never Deletes or Reconciles Absent Policies", "Import Runs Within withBrokerContext..." — depends on Phase 1 (index must exist), Phase 2 (row schema), Phase 4 (parsed/validated request inputs)

- [x] 5.1 **O4 pick (no architectural stakes, proposal P7)**: choose the
      CSV/XLSX parsing library (e.g. `papaparse` for CSV, `xlsx` or
      `exceljs` for XLSX) and add it as a plain dependency of `apps/api`
      (not `packages/schemas`, which is zod-only, and not
      `packages/integrations`, which holds service clients, not file-format
      libraries — proposal P7). Record the choice in this task's checkbox
      once made; no test-first step for the library choice itself.
- [x] 5.2 RED: `apps/api/src/services/import-policies.ts` test — a file
      parses into an array of row objects (CSV and, separately, XLSX
      fixtures both producing an equivalent row shape) before the parser
      integration exists.
- [x] 5.3 GREEN: implement file-to-rows parsing for both formats using
      5.1's chosen library, satisfying 5.2.
- [x] 5.4 RED (live, `describe.skipIf(!LIVE_TEST_DATABASE_URL)`, per F2's
      Phase 5.10 precedent for the boundary where real transactions are
      needed): one malformed row (invalid `end_date`) among 5 rows does not
      prevent the other 4 from being processed; the malformed row's result
      has `status: "failed"` with a field-named error. Traces to spec
      scenario "One malformed row does not fail the file".
- [x] 5.5 GREEN: implement the per-row loop — Zod-validate each row
      independently, catching validation failure into a per-row result
      rather than throwing out of the loop. Satisfies 5.4.
- [x] 5.6 RED (live): a new `(broker_id, phone)` pair with no existing
      contact creates one. Traces to spec's contact find-or-create
      requirement (creation half).
- [x] 5.7 RED (live): an existing contact with `full_name = "Ana Ruiz"`
      importing a row with an empty `full_name` cell retains `"Ana Ruiz"`.
      Traces to spec scenario "A blank spreadsheet field does not erase
      existing contact data".
- [x] 5.8 RED (live): an existing contact with `full_name = "Ana Ruiz"`
      importing a row with `full_name = "Ana R."` retains `"Ana Ruiz"` (not
      merged, not overwritten). Traces to spec scenario "A differing
      spreadsheet field does not overwrite existing contact data".
- [x] 5.9 RED (live): an existing contact with `doc_number IS NULL`
      importing a row with `doc_number = "123456"` ends up with
      `doc_number = "123456"`. Traces to spec scenario "A previously-null
      field is filled from the spreadsheet".
- [x] 5.10 GREEN: implement the contact upsert as
      `ON CONFLICT (broker_id, phone) DO UPDATE SET full_name =
      COALESCE(contacts.full_name, EXCLUDED.full_name)` and identically for
      `doc_type`/`doc_number` (proposal Approach). Satisfies 5.6-5.9.
- [x] 5.11 RED (live) — **dedicated adversarial consent test, per task
      brief; not folded into 5.6-5.10**: a fixture CSV whose header row
      includes a column literally named `consent` (and a second fixture
      variant named `acepta_terminos`), containing `true` or a plausible
      date, for one row that creates a new contact and one row that updates
      an existing contact with `consent_at IS NULL`. After import, assert
      both contacts have `consent_at IS NULL`, AND assert on the actual
      SQL/query issued by the import path (e.g. by inspecting the Drizzle
      query builder's generated statement, or spying on the query-execution
      call and asserting its column list) that `consent_at` appears in no
      `INSERT` or `UPDATE` column list — not merely that the end-state
      happens to be NULL, which a broken-but-accidentally-correct
      implementation could also produce. Traces to proposal P4 and spec
      scenario "A file with an adversarial consent-looking column leaves
      consent_at NULL", data model requirement "Import Never Writes
      contacts.consent_at".
- [x] 5.12 GREEN: confirm 5.11 passes by construction (the contact upsert
      built in 5.10 never references `consent_at`). **If RED is unattainable
      because the implementation is already correct by construction** (the
      COALESCE upsert from 5.10 has no `consent_at` column to begin with),
      validate by mutation testing instead, per the `extraction-schemas`
      convention: temporarily add `consentAt: sql\`now()\`` (or equivalent)
      to the upsert's column list, confirm 5.11 fails, then restore. State
      explicitly in the test file which convention (RED/GREEN or mutation)
      was used and why.
- [x] 5.13 RED (live): a row with a non-null `policy_number` that does not
      match any existing `(broker_id, policy_number)` inserts a new
      `policies` row. Traces to spec's idempotent-upsert requirement
      (insert half).
- [x] 5.14 RED (live): re-importing the identical file a second time
      updates the existing row(s) — `totals.inserted` is 0, `totals.updated`
      equals the row count, and the total `policies` row count for that
      broker is unchanged before and after. Traces to spec scenario
      "Re-importing an unedited file changes nothing and inserts nothing".
- [x] 5.15 RED (live): re-importing an edited file (same `policy_number`,
      different `end_date`) leaves exactly one row for that
      `(broker_id, policy_number)` pair, with the new `end_date`. Traces to
      spec scenario "Re-importing an edited file updates matching rows
      without duplication".
- [x] 5.16 GREEN: implement the policy upsert keyed on
      `(broker_id, policy_number)` using Phase 1's partial unique index,
      satisfying 5.13-5.15.
- [x] 5.17 RED (live): a row whose `policy_number` matches an existing
      policy but whose phone resolves to a different, existing contact
      fails that row with an error naming the policy_number/contact
      mismatch; the existing policy's `contact_id` is unchanged; no other
      row in the file is affected. Traces to spec scenario "A row whose
      policy_number matches but whose phone maps to a different contact
      fails the row", proposal Round 2 O5 (resolved: fail-the-row).
- [x] 5.18 GREEN: implement the mismatch check (compare the row's resolved
      `contact_id` against the existing policy's `contact_id` before
      upserting; fail the row if they differ) satisfying 5.17. This check
      MUST run before the upsert statement, not rely on a database
      constraint to reject it, since there is no unique constraint on
      `contact_id` alone to catch this.
- [x] 5.19 RED (live): a row with no `policy_number` always inserts a new
      `policies` row (never matched against an existing one), and its
      per-row result carries a `warnings` array with a non-idempotency
      message. Traces to spec scenario "An unnumbered row always inserts,
      never matches an existing row".
- [x] 5.20 RED (live): re-importing the identical file containing that same
      unnumbered row creates a second, distinct `policies` row with
      `policy_number IS NULL` for the same contact (two rows total), and
      both import responses flag the row with the warning. Traces to spec
      scenario "Re-importing a file with an unnumbered row creates a
      duplicate".
- [x] 5.21 GREEN: implement the no-`policy_number` branch as an
      unconditional `INSERT` (never routed through the upsert's
      `ON CONFLICT` path) plus the warning message, satisfying 5.19-5.20.
- [x] 5.22 RED (live): broker `B` has two existing policies, `POL-1` and
      `POL-2`; importing a file containing only `POL-1` (with edits) updates
      `POL-1` and leaves every column of `POL-2` exactly as it was. Traces
      to spec scenario "A policy absent from a re-imported file is
      untouched", proposal P6.
- [x] 5.23 GREEN: confirm 5.22 passes by construction (the per-row loop
      only ever touches rows present in the file; there is no
      delete/reconcile step to remove). **If RED is unattainable**, validate
      by mutation: temporarily add a reconciliation step that marks absent
      policies (e.g. sets `status = 'cancelled'` for policies not seen in
      the current import), confirm 5.22 fails, then remove it. State which
      convention was used.
- [x] 5.24 Confirm every write in this service — contact upsert, policy
      upsert/insert, and the broker-existence check — runs inside a single
      `withBrokerContext(brokerId, tx => ...)` call, one call per file
      import (per-row transactions are internal to that call, not separate
      `withBrokerContext` invocations, since `withBrokerContext` throws on
      reentrancy — see `packages/db/src/tenant.ts`'s reentrancy guard). If
      per-row rollback-without-losing-other-rows requires savepoints inside
      that one transaction, use `tx.transaction(...)` nesting inside the
      already-open broker context, not a second `withBrokerContext` call.
      Traces to spec "Import Runs Within withBrokerContext and Respects
      RLS", proposal Approach ("Per-row transaction, not one transaction for
      the file").

## Phase 6: The route + response shape — proposal Approach (response sketch), spec "Response Reports Per-Row Outcome and File-Level Totals" — depends on Phase 3, Phase 4, Phase 5

- [x] 6.1 RED: `apps/api/src/routes/admin/policies-import.ts` test — a file
      with 3 valid rows and 1 invalid row returns HTTP 200 with
      `totals.rows = 4`, `totals.failed = 1`, and a `rows` array of exactly
      4 entries, each carrying a 1-based `row` number matching its source
      position. Traces to spec scenario "A file with mixed outcomes returns
      200 with a full per-row report".
      **RED confirmed**: before the route module existed, the whole suite
      (all 8 tests) failed with "Failed to load url
      ../../../src/routes/admin/policies-import.js" — module-not-found, same
      convention as every prior phase's RED confirmation.
- [x] 6.2 GREEN: wire the route: admin-auth middleware (Phase 3) -> size/
      shape guards (Phase 4) -> import service (Phase 5) -> response
      assembly matching the proposal's response sketch. Satisfies 6.1.
- [x] 6.3 RED then GREEN, or mutation-tested if RED is impossible: confirm
      file-level rejections (auth failure, missing/unknown `brokerId`,
      size/row-count limit exceeded, missing required header) use a 4xx
      status, while any row-level failure alone (file itself well-formed
      and authorized) always returns 200. If this is correct by
      construction from the route's control flow (early 4xx returns happen
      before the per-row loop, which itself only ever returns 200), validate
      by mutation: temporarily make a row-level failure also flip the
      overall status to 4xx, confirm the test fails, then restore.
      **RED confirmed via module-not-found** (same as 6.1, since the whole
      test file failed before the route existed) **and additionally
      mutation-tested**, per this task's own instruction: temporarily
      changed the handler's final line to
      `c.json(result, result.totals.failed > 0 ? 422 : 200)`, re-ran the
      suite — both the mixed-outcome test (6.1) and the dedicated
      all-rows-fail test asserted `200` and failed with `expected 422 to be
      200`, confirming the mutation is caught — then reverted to
      `c.json(result, 200)` and confirmed green again. See
      apply-progress.md's Phase 6 section for the exact mutation diff.
- [x] 6.4 Verify `apps/api/src/index.ts` mounts the route at
      `POST /admin/policies/import`, wiring in the real
      `ADMIN_API_TOKEN` (Phase 3), the real `withBrokerContext`-based import
      service (Phase 5), and the real broker-lookup dependency (Phase 4) —
      following `createApp({ ... })`'s injected-dependency pattern so the
      route stays offline-testable with fakes, per `app.ts`'s established
      D-5-style boundary.
      **Done, with one necessary addition beyond wiring**: Phase 4 defined
      the `ResolveBrokerExists` injection point but never implemented a real
      `@dirus/db`-backed broker-existence lookup — none existed anywhere in
      `@dirus/db` to wire in. Added `brokerExists(brokerId)` to
      `packages/db/src/broker-existence.ts`, reusing `withBrokerContext` "as
      is" (Phase 1's own note: no new migration or unproven mechanism
      needed) rather than adding a new SECURITY DEFINER function/role: the
      `brokers` table's own `tenant_isolation` RLS policy is keyed on
      `id = current_setting('app.broker_id')`, so scoping the read to the
      CANDIDATE id being checked is itself the existence check. Exported
      from the barrel (`src/index.ts`) and added to the reviewed allowlist
      in `barrel-surface.test.ts`. See apply-progress.md's Phase 6 section
      for the full reasoning and why this is composition-adjacent wiring,
      not new business logic in any of the three protected files
      (`admin-auth.ts`, `import-policies.ts`, `import-policies-writer.ts`).
- [x] 6.5 Verify `pnpm --filter @dirus/api typecheck` and
      `pnpm --filter @dirus/api test` pass with the route fully wired.
      **Verified**: `pnpm --filter @dirus/api test` — 11 test files
      passed, 3 skipped (pre-existing live suites); 51 passed, 21 skipped.
      `pnpm --filter @dirus/api typecheck` — clean. `pnpm run lint` —
      clean. `pnpm run lint:deps` — clean, "no dependency violations found
      (125 modules, 308 dependencies cruised)". `pnpm -r run typecheck` —
      all 8 workspace projects clean. `pnpm -r run test` — every package
      green: `packages/db` 103 passed/34 skipped (includes the new
      `broker-existence.test.ts`, 3/3), `packages/integrations` 7/7,
      `apps/api` 51 passed/21 skipped.

## Phase 7: Live integration tests — proposal Success Criteria, spec "Import Runs Within withBrokerContext and Respects RLS" — depends on Phase 6

- [x] 7.1 RED then GREEN (live): broker A imports a file creating `contacts`
      and `policies` rows; a query scoped to broker B's `withBrokerContext`
      reads zero of broker A's newly imported rows. Mirrors F2's Phase 6
      two-broker live-fixture convention (seed via the real import path, not
      direct SQL inserts, so the test exercises the actual RLS-scoped
      transaction, not a hand-rolled substitute). Traces to spec scenario
      "Imported rows are visible only under the importing broker's context".
      **Written**, `apps/api/test/live/policies-import.live.test.ts` — both
      brokers seeded via real `app.request("/admin/policies/import", ...)`
      dispatch (never raw SQL for contacts/policies), broker B's own
      `APP_ROLE` session (real `set_config('app.broker_id', ...)`) asserted
      to see zero of broker A's rows, with a positive control (broker A's
      rows verified to exist via the `admin` bypass connection, and broker
      B's own imported rows verified visible to itself) so the negative
      assertion is not vacuous. **UNCONFIRMED in this environment** — no
      Postgres/Docker/Podman reachable (verified directly); reports SKIPPED,
      confirmed via `pnpm --filter @dirus/api test` (3/3 skipped, not
      erroring). Must run green in CI.
- [x] 7.2 RED then GREEN (live): a valid CSV and an equivalent XLSX (same
      logical rows, different file format) both import successfully,
      creating `contacts` and `policies` rows with the correct `broker_id`
      for both formats. Traces to proposal Success Criteria, first bullet.
      **Written**, same file — exercises the real `parseImportFile` (Phase
      5's `papaparse`/`xlsx` parser) through the real route for both
      formats, then verifies both contacts and both policies exist with the
      correct `broker_id` via a direct DB query. **UNCONFIRMED in this
      environment**, same reason as 7.1.
- [x] 7.3 RED then GREEN (live): a request with a wrong or missing admin
      token returns 401 and, checked directly against the database, writes
      zero `contacts` or `policies` rows — the end-to-end version of Phase
      3's offline middleware test, run through the real route and a real
      (would-be) write path. Traces to proposal Success Criteria, "A request
      with a wrong or missing admin token gets 401 with no rows written."
      **Written**, same file — asserts 401 for both a wrong-length token and
      a missing token header, then queries `contacts`/`policies` directly
      for `count(*) = 0` scoped to the request's `brokerId`, not merely the
      HTTP status. **UNCONFIRMED in this environment**, same reason as 7.1.
- [x] 7.4 Run `pnpm -r typecheck` and `pnpm -r test` from a clean state;
      cross-check every proposal Success Criteria checkbox against completed
      tasks, noting any that remain unconfirmed in this environment (no live
      Postgres reachable) and must be confirmed in CI, following F2's
      Phase 6.8 precedent for how to document that gap honestly rather than
      silently checking boxes.
      **Done.** `pnpm -r run typecheck` — all 8 workspace projects clean.
      `pnpm -r run test` — every package green: `packages/db` 103
      passed/34 skipped, `packages/schemas` 72/72, `packages/integrations`
      7/7, `apps/api` 51 passed/24 skipped (24 skips = every live suite in
      this change, including the 3 new Phase 7 tests, confirmed SKIPPED not
      erroring). `pnpm run lint` clean. `pnpm run lint:deps` clean (126
      modules, 317 dependencies, zero violations). Full honest cross-check
      of every Success Criteria bullet recorded in `proposal.md`'s own
      Success Criteria section: 2 of 9 items are genuinely confirmed by a
      real run in this environment (the offline mixed-outcome test, and this
      repo-wide typecheck/test/lint pass itself); the remaining 7 depend on
      a live Postgres connection unavailable here and are marked
      **UNCONFIRMED, pending CI** rather than silently checked off.
- [x] 7.5 Update `openspec/ROADMAP.md`'s A1 entry to correct the "requires no
      schema changes" claim the proposal identifies as wrong (proposal
      Intent, "ROADMAP correction required").
      **Done.** `openspec/ROADMAP.md`'s A1 "Notes" bullet now states the
      migration requirement explicitly (the partial unique index Phase 1
      added), using the proposal's own correction language ("`policies` and
      `contacts` already exist" is true of the tables, but the constraint
      idempotent upsert depends on was missing), rather than repeating the
      "requires no schema changes" claim this proposal's own Intent section
      identifies as wrong.

**No concurrency suite in this phase, by design.** Proposal Out of Scope
states imports are synchronous, one file, one request; unlike F2's Phase 6,
there is no concurrent-delivery race to prove here, and inventing one would
test a scenario this change's own design explicitly does not support
(no queue, no retries, no concurrent writers to the same import).
