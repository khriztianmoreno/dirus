# Proposal: Policy bulk import

## Intent

`renewal-agent` (A2) triggers off `policies.end_date` and messages `contacts.phone`. Today both tables are empty except for whatever `whatsapp-webhook-ingress` (F2) happens to have created from an inbound message — which is contacts only, never policies. There is no path in the repo that puts a policy row in the database. A1 exists to seed a broker's existing book of business from the spreadsheet they already maintain, so A2 has something to renew on day one.

Two properties must be proven, not assumed. Re-importing a corrected spreadsheet must update rows rather than duplicate them (brokers will re-import; that is the normal workflow, not the exception). And importing a spreadsheet must not grant Habeas Data consent — Ley 1581 consent is an act by the data subject, not a column in a broker's Excel file.

**ROADMAP correction required.** A1's line reads "requires no schema changes — `policies` and `contacts` already exist". That is wrong. `packages/db/src/schema/policies.ts` declares `policyNumber: text("policy_number")` as nullable with **no unique constraint anywhere**. Idempotent upsert by `(broker_id, policy_number)` is impossible without a new migration.

## Scope

### In Scope

- `POST /admin/policies/import` in `apps/api` — a synchronous multipart upload accepting one CSV or XLSX file.
- A provisional shared-bearer-token auth middleware for the `/admin` prefix (see P2).
- A new migration adding a **partial** unique index on `policies (broker_id, policy_number) WHERE policy_number IS NOT NULL` (see P5).
- Idempotent per-row upsert of `policies`, keyed on that index.
- Find-or-create of `contacts` by the existing `UNIQUE (broker_id, phone)`, which must precede every policy insert because `policies.contact_id` is `NOT NULL`.
- Per-row validation with a per-row result report: one malformed row must not fail the file (issue #14 acceptance criterion).
- A Zod row schema in `packages/schemas` (zod-only dependency — respects the existing rule; `packages/schemas/package.json` depends on nothing but `zod`).
- The consent invariant as an executable test (see P4).
- Everything inside `withBrokerContext(brokerId, …)` from `@dirus/db`.

### Out of Scope

- **Real broker/admin authentication.** Superseded by `admin-dashboard` (C1). What ships here is a compensating control with a deliberate expiry (P2).
- **Any UI.** No upload page, no column-mapping wizard, no preview. C1's territory.
- **Consent capture.** `renewal-agent` (A2) captures consent on the first outbound HSM and records `consent_at` on reply. A1's only obligation is to not falsely grant it.
- **Async/job-queue import.** One file, one request, one response. If real files turn out to be large enough to time out, that is a follow-up change with evidence behind it.
- **Interactive column mapping.** A fixed header contract, documented and validated. Per-broker mapping profiles are later work.
- **Deletion or reconciliation.** A policy absent from a re-imported file is left untouched, never soft-deleted. Import is additive/updating only.
- **Extraction-sourced policies.** That is `ingestion-agent` (B2), a different source with different confidence semantics.

## Capabilities

### New Capabilities

- `policy-import`: authenticated bulk ingestion of policy rows — row validation, contact find-or-create, idempotent policy upsert, per-row result reporting, consent invariant.

### Modified Capabilities

- `data-model`: adds the partial unique index on `policies (broker_id, policy_number)`. This is a spec-level constraint change (it defines what "the same policy" means), so it needs a delta spec.

## Approach

Synchronous and boring. `POST /admin/policies/import` → admin-token middleware → read `brokerId` + `file` from the multipart body → parse to rows → for each row: Zod-validate → open `withBrokerContext(brokerId, …)` → upsert contact → upsert policy → record the row result → respond with the full report.

Per-row transaction, not one transaction for the file. Partial success is the *specified* behavior (issue #14), and a single transaction cannot both roll back a bad row and keep the good ones without savepoint gymnastics. Design may still choose savepoints inside one connection for throughput; the observable semantic is fixed here.

Contact upsert fills blanks only: `ON CONFLICT (broker_id, phone) DO UPDATE SET full_name = COALESCE(contacts.full_name, EXCLUDED.full_name)` and likewise for `doc_type` / `doc_number`. A spreadsheet must never overwrite data the system already learned from the customer directly. `consent_at` appears in no INSERT and no UPDATE column list, ever.

Response sketch:

```jsonc
{
  "brokerId": "…",
  "totals": { "rows": 120, "inserted": 98, "updated": 20, "failed": 2 },
  "rows": [
    { "row": 2, "status": "inserted", "policyId": "…", "contactId": "…" },
    { "row": 3, "status": "updated",  "policyId": "…", "contactId": "…" },
    { "row": 4, "status": "inserted", "policyId": "…",
      "warnings": ["no policy_number: this row is not idempotent and will duplicate on re-import"] },
    { "row": 5, "status": "failed",
      "errors": [{ "field": "end_date", "message": "Invalid date" }] }
  ]
}
```

HTTP 200 with `failed > 0` — the request succeeded, some rows did not. A 4xx is reserved for a rejected *file* (bad auth, unknown broker, unparseable file, missing required headers).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/api/src/routes/admin/policies-import.ts` | New | The endpoint |
| `apps/api/src/middleware/admin-auth.ts` | New | Provisional shared-token middleware, mirroring `webhook-auth.ts` |
| `apps/api/src/services/import-policies.ts` | New | Row loop, find-or-create, upsert, report |
| `apps/api/src/env.ts` | Modified | `ADMIN_API_TOKEN` via the existing `readRequired` pattern |
| `apps/api/package.json` | Modified | CSV/XLSX parser dependency |
| `packages/schemas` | Modified | Import row schema + column contract |
| `packages/db/src/schema/policies.ts` + migrations | Modified | Partial unique index |
| `openspec/ROADMAP.md` | Modified | Correct the "no schema changes needed" claim |

## Product Decisions

Settled before this proposal; inputs to spec and design, not open questions.

- **P1 — This ships as an HTTP endpoint, not a CLI script.** A CLI would dodge the auth question entirely, but it also means a broker's spreadsheet can only be imported by someone with a shell on the machine — which makes pilot onboarding a developer task forever and gives C1 nothing to build on. The cost is accepted explicitly: we must decide an auth mechanism now (P2). Path is `POST /admin/policies/import` — the `/admin` prefix exists so the provisional auth is a **single mount point** C1 replaces, not a decision scattered across routes.

- **P2 — Auth is a shared bearer token, and it is provisional by design.** It mirrors `webhook-auth.ts`'s D-4 pattern exactly: a fixed-length (≥32 byte) server-configured secret compared with `crypto.timingSafeEqual`, sent in a header, 401 with an empty body on failure. It authenticates *the caller*, not the payload, and it is replayable by anyone who observes it. This is a compensating control, not a login system. It is superseded the moment `admin-dashboard` (C1) ships real broker/admin authentication. Constraint on the implementation: keep it in one middleware file with no auth logic in the route or service, so the swap is a one-file change. Do not build roles, scopes, or expiry into it — that is C1's job and guessing at it now produces the wrong shape.

- **P3 — `brokerId` is an explicit request parameter, never inferred from the token.** It travels as a `brokerId` form field in the same multipart body as the file. The token proves "this caller may import for someone"; it does not say *for whom*. This is F2's tenant-resolution lesson restated: conflating authentication with tenant identification is how cross-tenant writes happen. A form field rather than a query string keeps the tenant and the file it applies to in one atomic request entity, and keeps broker identifiers out of proxy access logs.

- **P4 — The import path never writes `contacts.consent_at`. Full stop.** Not on insert, not on update, not if the spreadsheet has a "consent" or "autorización" column, not if that column says `true`, not if it contains a plausible date. A source file cannot manufacture consent under Ley 1581. This is one testable line — `consent_at` must not appear in any column list the import path emits — and it must have a test that feeds a file *with* a consent column and asserts `consent_at IS NULL`. Consent capture is A2's job at first outbound contact.

- **P5 — Idempotency is keyed on `policy_number`, and rows without one are honestly non-idempotent.** The migration adds `CREATE UNIQUE INDEX … ON policies (broker_id, policy_number) WHERE policy_number IS NOT NULL`.
  - A plain `UNIQUE (broker_id, policy_number)` would *appear* to work while silently permitting unlimited duplicate NULL rows — Postgres treats NULLs as distinct in unique indexes. Same behavior, but the constraint would lie about its own intent.
  - `NULLS NOT DISTINCT` (PG15+) is actively wrong: it would collapse every no-policy-number row for a broker into a single row, destroying real distinct policies.
  - The partial index says exactly what is true: **numbered policies participate in idempotency; unnumbered ones do not.**
  - Consequence, stated rather than discovered: a row with no `policy_number` **always inserts a new policy**, so re-importing a file containing such rows creates duplicates. The response flags every such row with an explicit warning (see the sketch above) so the broker sees it at import time, not three months later. This is specified, tested behavior — not a surprise.

- **P6 — A re-imported file updates existing policies; it never deletes.** Absence from a later file means "not in this file", not "cancelled". Deriving cancellations from omission would destroy live policies on a partial upload.

- **P7 — The parser is a plain dependency of `apps/api`, not a new package.** Likely `papaparse` for CSV plus `xlsx`/`exceljs` for XLSX — **TBD, pick during apply; no architectural stakes.** It does *not* go in `packages/schemas`, which is zod-only by rule, and it does *not* go in `packages/integrations`, which holds third-party *service* clients (Chatwoot), not file-format libraries. `apps/api` is the only consumer; a package for one consumer is premature. The *row schema* does go in `packages/schemas` — zod-only, reusable by `apps/jobs` later.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| The partial unique index fails to create because existing `policies` rows already violate it | Low | No production data yet. Migration must still be written to fail loud rather than silently drop conflicting rows. Verify against a seeded live test. |
| Real broker spreadsheets use column names we never guessed | **High** | **NEEDS CONFIRMATION** — no real broker file exists to design against (the pilot-onboarding workstream produces them). Ship a documented fixed header contract; a rejected file names the missing headers explicitly. Per-broker mapping is a follow-up with evidence. |
| A large file times out the synchronous request | Med | **NEEDS CONFIRMATION** on realistic book sizes and on any platform request timeout. Enforce an explicit max row count / file size that rejects loudly with a clear message rather than dying mid-import. Partial-row transactions mean a timeout leaves committed rows, not corruption. |
| The admin token leaks and becomes a permanent cross-tenant write primitive | Med | Accepted and bounded: it is provisional (P2), the endpoint only writes, `brokerId` is explicit and logged, and C1 removes it. Token must be rotatable via env and never logged. |
| Contact upsert overwrites customer-provided data with stale spreadsheet data | Med | `COALESCE`-style fill-blanks-only upsert (Approach). Must be a spec scenario, not an implementation detail. |
| Silent duplicate policies from repeated import of unnumbered rows | Med | P5 warning in the response + explicit test. |
| Consent accidentally backfilled by a future well-meaning refactor | Low | P4's negative test is the guard. It must assert on a file that *does* carry a consent column. |

## Rollback Plan

Revert the commit range and run the migration's down path (`DROP INDEX`). The index is additive; dropping it cannot lose data, only permit duplicates that did not exist before. The endpoint disappears; nothing depends on it yet (A2 is not built). Imported rows are *not* rolled back automatically — if bad data was imported, deleting it is a manual, broker-scoped `DELETE` inside `withBrokerContext`, which must be written down in the change's notes rather than improvised under pressure.

## Dependencies

- `scaffold-monorepo` (F1) — applied.
- `whatsapp-webhook-ingress` (F2) — applied. Not a hard dependency, but `apps/api` structure, `env.ts` `readRequired`, and `webhook-auth.ts`'s token pattern are all borrowed from it.
- `LIVE_TEST_DATABASE_URL` for migration and RLS-scoped upsert tests, using the conventions in `packages/db/test/migrations/live-rls-verification.test.ts`.
- At least one **real broker spreadsheet** to confirm the column contract. Not blocking for spec/design; blocking for calling the column contract confirmed.

## Open Questions

- **O1** — Exact required/optional column contract. `insurer`, `line`, `end_date` and a contact phone are `NOT NULL` in the schema and therefore required. Everything else is open until a real file exists. **NEEDS CONFIRMATION.**
- **O2** — Max file size / row count, and whether the deploy platform imposes a request timeout that makes synchronous import untenable. **NEEDS CONFIRMATION.**
- **O3** — Does an unknown or non-existent `brokerId` return 404 or 401? Leaning 404 with an operational log line, mirroring F2's P4 (silent rejection makes onboarding misconfiguration invisible), but a 404 also confirms broker-id existence to an attacker holding the shared token. Design decides.
- **O4** — CSV/XLSX library choice (P7). No architectural stakes; pick during apply.
- **O5** — Does a row whose `policy_number` matches an existing policy but whose `phone` maps to a *different* contact update the policy's `contact_id`, or fail the row? Leaning fail-the-row: silently repointing a policy at another customer is worse than a rejected row.
- **O6** — Header name for the admin token. `X-Dirus-Admin-Token` mirrors `X-Dirus-Webhook-Token`; confirm no preference for `Authorization: Bearer`.

## Product Decisions — Round 2 (post-spec)

Settled to unblock `sdd-tasks` without a separate design phase — these are
narrow, low-stakes calls, not architecture. Spec's `NEEDS CONFIRMATION`
markers on O3, O5, O6 and O2 are resolved here; O1 and O4 remain open as
originally scoped (no real broker file exists yet; the CSV/XLSX library has
no architectural stakes and is picked during apply).

- **O3 resolved — 404, with an operational log line.** An unknown `brokerId`
  is treated as a not-found resource, mirroring F2's P4 tenant-resolution-miss
  pattern: `console.error("policy_import_unknown_broker", { brokerId })` — a
  single structured argument, never file content — then `404`. The token
  authenticates "this caller may import for some broker"; it does not vouch
  for which one, so a wrong `brokerId` is the caller's error, not an auth
  failure. The confirmation-leak concern is accepted: the token holder is
  already a trusted administrative caller, not an anonymous attacker: the
  same trust boundary the shared token itself already rests on.
- **O5 resolved — fail-the-row.** A `policy_number` match against a `phone`
  that maps to a different `contact_id` fails that row with a specific error
  (e.g. `"policy_number belongs to a different contact"|"policy_number
  pertenece a otro contacto"`) rather than repointing the policy. Silently
  moving a policy to a different customer on a spreadsheet typo is a data
  integrity incident; a rejected row is a nuisance the broker can fix and
  re-upload.
- **O6 resolved — `X-Dirus-Admin-Token`.** Matches `X-Dirus-Webhook-Token`'s
  naming exactly; one convention for "our own shared-secret headers" rather
  than mixing it with the generic `Authorization: Bearer` scheme other
  callers might expect to carry real credentials.
- **O2 resolved — 5 MB file size, 5,000 row cap, both enforced before
  parsing begins.** No real broker file exists to calibrate against, so this
  is a conservative starting limit chosen to keep a synchronous request
  inside a typical platform HTTP timeout, not a measured number. Exceeding
  either limit rejects the whole request before any row is processed (this
  is the one whole-file rejection this change has — a request too large to
  process safely is not a partial-file scenario). Revisit once real broker
  files are seen; nothing about this change makes the limit hard to change
  later — it is a guard at the top of the handler, not baked into the schema
  or the migration.

## Success Criteria

Cross-checked task 7.4, against the state of the repo after Phase 7. This
environment has no reachable Postgres/Docker/Podman (verified directly — see
`apply-progress.md`'s Phase 7 section), so every criterion whose only proof
is a live test is disclosed as **UNCONFIRMED, pending CI** rather than
silently checked, per this change's own Phase 5 precedent (`import-policies
.live.test.ts`'s consent-test disclosure) and F2's Phase 6.8 precedent.

- [x] A valid CSV and an equivalent XLSX both import, creating `contacts`
      and `policies` rows with the correct `broker_id`. Implemented (Phase
      5's `parseImportFile`, Phase 6's route) and tested end-to-end through
      the real route in `apps/api/test/live/policies-import.live.test.ts`
      (task 7.2). **UNCONFIRMED, pending CI** — the live suite reports
      SKIPPED in this environment.
- [x] Re-importing the same file with edited values **updates** the
      matching policies and inserts nothing new — verified by row count
      before and after. Implemented (Phase 5's `upsertPolicy`) and tested
      in `import-policies.live.test.ts` (tasks 5.14/5.15). **UNCONFIRMED,
      pending CI.**
- [x] A file with one malformed row imports every other row and returns
      per-row results identifying exactly which row failed and why.
      Implemented (Phase 5's per-row loop) and tested both live
      (`import-policies.live.test.ts` task 5.4, **UNCONFIRMED, pending
      CI**) and offline — `policies-import.test.ts`'s task 6.1 test
      (mixed-outcome file, 3 valid + 1 invalid row) **actually ran and
      passed** in this environment (`pnpm --filter @dirus/api test`), so
      this criterion has partial, real confirmation independent of a live
      database.
- [x] **Non-negotiable**: a file containing a consent/authorization column
      leaves `contacts.consent_at` NULL on every created and every updated
      contact. Implemented (Phase 5's `upsertContact`, which has no
      `consent_at` column in its `.set()` by construction) and tested in
      `import-policies.live.test.ts` (task 5.11), including a bound-parameter
      assertion on the real SQL, not just the end-state. **UNCONFIRMED,
      pending CI** — additionally, the test's own mutation-testing pass
      (task 5.12, temporarily adding `consentAt: row.consent` to confirm the
      test actually discriminates a regression) has never been run in any
      environment yet either; both are flagged for whoever runs this suite
      in CI first.
- [x] A row with no `policy_number` inserts, is flagged with the
      non-idempotency warning, and inserts *again* on re-import — the
      documented behavior, asserted. Implemented (Phase 5's unconditional
      `INSERT` branch) and tested in `import-policies.live.test.ts` (tasks
      5.19/5.20). **UNCONFIRMED, pending CI.**
- [x] An existing contact's `full_name` is not overwritten by a blank or
      differing spreadsheet value. Implemented (Phase 5's
      `COALESCE`-based fill-blanks-only upsert) and tested in
      `import-policies.live.test.ts` (tasks 5.7/5.8). **UNCONFIRMED,
      pending CI.**
- [x] A request with a wrong or missing admin token gets 401 with no rows
      written. Implemented (Phase 3's `admin-auth.ts`) and tested at two
      levels: `admin-auth.test.ts` (offline, **actually ran and passed** —
      proves 401 and that a downstream handler is never invoked) and
      `policies-import.live.test.ts` (task 7.3, the literal database-level
      "zero rows written" proof through the real route). The offline half
      is confirmed; the live, DB-level half is **UNCONFIRMED, pending CI.**
- [x] A live test proves imported rows are only visible under the
      importing broker's `withBrokerContext`. Written in
      `apps/api/test/live/policies-import.live.test.ts` (task 7.1): two
      brokers, both seeded through the real import route (never raw SQL for
      the data under test), one broker's `withBrokerContext`-scoped session
      asserted to see none of the other's rows, with a positive control
      proving the assertion is not vacuous. **UNCONFIRMED, pending CI** —
      this test cannot execute without a reachable Postgres, which this
      environment does not have.
- [x] `pnpm -r typecheck` and `pnpm -r test` pass; `packages/schemas` still
      imports nothing but `zod`. **CONFIRMED, actually run in this
      environment**: `pnpm -r run typecheck` — all 8 workspace projects
      clean. `pnpm -r run test` — every package green (`packages/db` 103
      passed/34 skipped, `packages/schemas` 72/72, `packages/integrations`
      7/7, `apps/api` 51 passed/24 skipped — the 24 skips are every live
      suite across this change, including the 3 new Phase 7 tests, all
      confirmed SKIPPED rather than erroring or silently omitted).
      `packages/schemas/package.json` dependencies: `{ "zod": "^4.4.3" }`
      only. `pnpm run lint` and `pnpm run lint:deps` also clean (126
      modules, 317 dependencies cruised, zero violations).

**Summary**: every Success Criteria item is implemented and has a written
test proving it. Two of nine items (the offline mixed-outcome test and the
repo-wide typecheck/test/lint suite) are genuinely confirmed by an actual
run in this environment. The remaining seven depend on a live Postgres
connection this environment does not have and are honestly disclosed as
UNCONFIRMED rather than checked off on the strength of code review alone —
this must be closed out by a CI run, per this change's own established
disclosure convention (Phase 1's task 1.6, Phase 5's live suite, Phase 6's
mutation-testing notes).
