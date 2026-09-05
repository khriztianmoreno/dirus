# Apply Progress: Policy bulk import

**Mode**: Strict TDD, Phase 1 only, per the ordering constraint at the top of
`tasks.md`. Phase 1 is the migration plus its live proof — Phases 2-7 are
explicitly out of scope for this batch and were not touched. Task 1.6 is a
STOP gate: it is left unchecked below and Phases 2-7 have not been started
speculatively.

**Environment constraint (verified, not assumed)**: `docker info` fails
(daemon not reachable, exit 1), no `podman` binary, no `psql` binary, and
`nc -z localhost 5432` reports closed. **No Postgres of any kind is
reachable in this environment.** The live test (task 1.5) is therefore
correctly gated (`describe.skipIf(!LIVE_TEST_DATABASE_URL)`) and confirmed
to actually skip — not error — in a real `vitest run`. It must be proven
green in CI before task 1.6 can be checked and before Phase 5 begins.

## What was executed for real (this environment)

- `packages/db/test/migrations/policy-number-unique-index.test.ts`
  (structural, offline): **RED then GREEN, both actually run.**
  - RED: run before `migrations/0005_policy_number_unique_index.sql`
    existed — failed with `ENOENT: no such file or directory` on the
    migration path, i.e. failed for the right reason (the file genuinely did
    not exist yet), not a typo or a wrong assertion.
  - GREEN: after generating the migration and updating the migration's
    header comment once (see "One iteration inside GREEN" below), all 3
    assertions pass.
- `packages/db/test/migrations/drift.test.ts` (`drizzle-kit check`):
  confirmed still green after the schema change — no edit to this file was
  needed. See "Task 1.4" below for why.
- `packages/db/test/migrations/live-policy-number-unique-index.test.ts`:
  written (task 1.5), confirmed to **skip** (3/3 skipped, 0 run) with
  `LIVE_TEST_DATABASE_URL` unset — not executed for real in this
  environment.
- `pnpm --filter @dirus/db run test`: 16 passed | 6 skipped (22 files), 100
  passed | 34 skipped (134 tests). The 6 skipped files are the pre-existing
  live suites plus this batch's new `live-policy-number-unique-index.test.ts`.
- `pnpm -r run test` (repo-wide): `packages/db` as above, `packages/integrations`
  7/7, `apps/api` 27 passed | 8 skipped (9 files, 2 skipped) — all pre-existing,
  unaffected by this batch.
- `pnpm -r run typecheck` (repo-wide): clean, all 8 workspace projects with a
  `typecheck` script.
- `pnpm run lint` (repo-wide eslint): clean, no output.
- `pnpm run lint:deps` (dependency-cruiser): clean — "no dependency
  violations found (110 modules, 258 dependencies cruised)".

## What was NOT executed (must run in CI — task 1.6's gate)

- All 3 `it()`s in `live-policy-number-unique-index.test.ts`:
  1. Two policies with the same `(broker_id, policy_number)` are rejected
     (unique-violation, exactly one row remains).
  2. Two sequential inserts with `policy_number = NULL` for the same broker
     both succeed (two distinct rows).
  3. The same `policy_number` across two different brokers succeeds for
     both.
- Because none of this ran, the index's *enforced* behavior remains
  formally unproven in this environment — the migration text is structurally
  correct as far as static analysis and `drizzle-kit check` can confirm, but
  that is exactly the standard this task brief said is not sufficient on its
  own. **Task 1.6 is left unchecked in `tasks.md`; it must be confirmed
  green in CI before Phase 5 (the first phase that writes to `policies`)
  begins.**

## Migration: `packages/db/migrations/0005_policy_number_unique_index.sql`

Generated with `drizzle-kit generate --name=policy_number_unique_index`
(plain `generate`, not `--custom`) — a deliberate, disclosed departure from
the task text's literal "`drizzle-kit generate --custom`, following 0004's
precedent" instruction:

- **0004 had no Drizzle schema change to diff against** (it adds a role,
  policy, and `SECURITY DEFINER` function — none of that is expressible in
  `packages/db/src/schema/*.ts`), so `--custom`'s empty stub was the only
  option there, and the migration's SQL was hand-written into it in full.
- **This migration does have a schema change**: `policies.ts` gained a
  second index declaration. Running plain `drizzle-kit generate` diffs the
  current schema against `migrations/meta`'s snapshot and produces both the
  correct SQL *and* a new `meta/0005_snapshot.json`, which is exactly what
  keeps `drift.test.ts`'s `drizzle-kit check` green without any hand
  authoring of the SQL or manual snapshot editing. Using `--custom` here
  would have produced an empty stub with no snapshot update, and hand-typing
  the DDL would have left the committed migration and the schema's snapshot
  free to diverge — the exact failure mode task 1.4 exists to catch.
- The generated SQL is byte-for-byte the same statement `drizzle-kit` would
  regenerate from the schema today (verified by deleting and re-running
  `generate` once, before adding the down-path comment — see "One iteration
  inside GREEN" below): `CREATE UNIQUE INDEX
  "policies_broker_id_policy_number_index" ON "policies" USING btree
  ("broker_id","policy_number") WHERE "policies"."policy_number" IS NOT
  NULL;`.

Schema-side (`packages/db/src/schema/policies.ts`): added
`uniqueIndex().on(table.brokerId, table.policyNumber).where(sql\`${table.policyNumber} IS NOT NULL\`)`
alongside the existing `index().on(table.brokerId, table.endDate).where(...)`
partial index, following that index's exact pattern (the `sql` tag is
required for the same reason documented on the existing index: `eq()` would
render as a bound `$1` placeholder, invalid inside a raw DDL `WHERE`
clause).

### One iteration inside GREEN

The migration's first draft included a header comment reasoning through why
`NULLS NOT DISTINCT` was rejected — which itself contained the literal
substring `NULLS NOT DISTINCT` and immediately failed
`policy-number-unique-index.test.ts`'s third assertion (`not.toMatch(/NULLS
NOT DISTINCT/i)`), since that assertion scans the whole committed file, not
just the `CREATE INDEX` statement. Reworded the comment to describe the
PG15+ feature without using its literal clause name. This is disclosed here
because the same trap will recur for anyone documenting *why* a forbidden
SQL shape was rejected directly inside the file a structural test scans
verbatim.

### Down path (task 1.3)

A comment block at the end of the migration file (not a scripted, separate
file — this migration sequence has no down-runner, consistent with
0000-0004): `DROP INDEX "policies_broker_id_policy_number_index";`, with the
proposal's own Rollback Plan wording ("additive; dropping it cannot lose
data, only permit duplicates that did not exist before") carried into the
comment.

### Task 1.4 — drift check

`drift.test.ts` needed no edit. It runs `drizzle-kit check` generically
(schema vs. `migrations/meta` snapshots), which already covers any new
index added to any table — it is not hand-listing `policies`' or
`extractions`' indexes by name (that specificity lives in
`partial-indexes.test.ts`, a different, narrower file that asserts on
`0000_init.sql`'s original two partial indexes only and was correctly left
untouched, since it documents *those* two indexes specifically, not "all
indexes ever"). Confirmed by running `pnpm exec vitest run
test/migrations/drift.test.ts` after the schema + migration changes: still
green, "Everything's fine".

## Test file: `packages/db/test/migrations/live-policy-number-unique-index.test.ts`

Extends `live-rls-verification.test.ts`'s conventions: `LIVE_TEST_DATABASE_URL`
gate, `assertThrowawayDatabase` before any destructive statement, a
per-run randomly-named throwaway schema (never `public`), and a
`safeToMutate` flag so a refused `beforeAll` can never let `afterAll` run a
destructive statement.

**One disclosed, deliberate deviation** from that file's shape: no
`OWNER_ROLE`/`APP_ROLE` split, and `0002_rls_policies.sql` is never applied.
The behavior under test is the unique index alone, not RLS — `policies`
only carries `FORCE ROW LEVEL SECURITY` once 0002 runs, and this suite has
no RLS assertion to make. All statements run on the single `admin`
connection inside the throwaway schema, where no RLS policy is ever
installed.

This directly avoids the two mistakes documented in
`openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/apply-progress.md`'s
Phase 5 section (CI's first two round-trips there):

1. **Seeding as a non-superuser role bound by `FORCE ROW LEVEL SECURITY`
   instead of admin.** Avoided by construction: since 0002 is never applied
   here, no role is ever FORCE-bound, so there is no equivalent trap to fall
   into. If a future phase needs to combine this index test with RLS
   assertions, it must adopt that file's admin-seeds-fixtures convention
   explicitly rather than seeding through an RLS-bound owner role.
2. **Sharing fixture state across `it()` blocks without scoping assertions
   to what each test itself created.** Each of the 3 `it()`s creates its own
   broker(s) and contact(s) with `randomUUID()` ids and unique phone
   numbers, and every count/row assertion is scoped by `broker_id`/
   `policy_number` values unique to that test (e.g.
   `WHERE broker_id = $1 AND policy_number = $2`), never a bare count across
   the whole suite.

### The three scenarios (data-model delta spec)

1. **Collision**: two inserts with the same `(broker_id, policy_number)` —
   the second `rejects.toThrow(/duplicate key value violates unique
   constraint/i)`, and a `count(*)` scoped to that `(broker_id,
   policy_number)` pair is `1` afterward.
2. **Non-collision (NULL)**: two sequential inserts with
   `policy_number = NULL` for the same broker both succeed; a `count(*)`
   scoped to that `broker_id` with `policy_number IS NULL` is `2` afterward.
3. **Cross-broker**: the same `policy_number` inserted for two different
   brokers succeeds for both; a query scoped to that `policy_number` returns
   both broker ids.

## Whether the mutation test adds signal for the NULL-vs-NULL check — worked through explicitly, per the task brief's instruction

**No, a mutation test on this specific assertion adds no discriminating
signal, and the test file's own comment says so rather than silently
running one for appearances.**

Reasoning: Postgres's unique-index implementation already treats every
`NULL` as distinct from every other `NULL`, in *any* unique index — partial
or not, `WHERE` clause or none. That is standard SQL null semantics, not a
`WHERE`-clause-specific behavior. Concretely:

- **Partial index** (`... WHERE policy_number IS NOT NULL`, the real
  migration): a row with `policy_number = NULL` does not even enter the
  index's row set, since it fails the partial predicate. Two such rows never
  collide. Insert succeeds twice.
- **Plain unique index** (`UNIQUE (broker_id, policy_number)`, no `WHERE`):
  both NULL rows *do* enter the index, but NULL is defined to never equal
  NULL for uniqueness purposes (`ON CONFLICT`/unique-index semantics
  standard). Insert succeeds twice — for a completely different reason (not
  filtered out; compared and found "not equal"), but the same observable
  outcome.
- **`NULLS NOT DISTINCT`** (PG15+, the shape both the proposal and the spec
  explicitly reject) is the one shape where this specific test *would* flip:
  it makes NULL equal NULL for uniqueness purposes, so the second insert
  would raise a unique-violation and the test's `count(*) = 2` assertion
  would fail.

So temporarily dropping the migration's `WHERE` clause (partial → plain)
and re-running this specific `it()` would **not** produce a RED state — it
would stay green, proving nothing, and a mutation "test" run against that
mutation would misleadingly look like a passed regression check when it is
actually a no-op. The assertion that *does* discriminate partial-vs-plain is
`policy-number-unique-index.test.ts`'s structural check for the literal
`WHERE "policies"."policy_number" IS NOT NULL` clause in the committed
migration text — that is a real, load-bearing guard against a future
"simplification" to a plain unique index, and it is why the data-model
spec's own scenario for that distinction is a *structural* SQL-text
assertion, not a live-database behavioral one.

Mutation testing this specific live assertion would only add real signal
against the `NULLS NOT DISTINCT` shape (add that clause to the migration
locally, confirm this `it()` goes RED, then revert) — that mutation was not
run here because it cannot be executed at all without a reachable Postgres
in this environment (mutation-testing a live test still requires actually
running it). It is recorded as a documented follow-up: whoever runs task 1.6
in CI can, as a one-time confidence check, temporarily add `NULLS NOT
DISTINCT` to the migration, confirm assertion 2 fails, then revert — but it
is not a blocking requirement, since the structural test already pins the
migration's SQL shape by text, and the live test's job (per the data-model
spec's own scenario split) is to prove the *other* two scenarios (rejection
on collision, permission across brokers) that plain-unique and partial
indexes do NOT already share.

## Deviations from a literal reading of `tasks.md`

1. Used plain `drizzle-kit generate --name=...` instead of `--custom` for
   task 1.2 — see "Migration" section above for the full reasoning (0004's
   `--custom` precedent applied to a migration with no schema diff; this one
   has a schema diff, and plain `generate` is what keeps `drift.test.ts`
   green without hand-editing the snapshot).
2. Task 1.4 required no code change — `drift.test.ts` already covers new
   indexes generically. Confirmed rather than assumed by running it after
   the schema change.

No other deviations. All six Phase 1 tasks implemented; task 1.6 (the CI
gate) is correctly left unchecked pending a CI run.

## Not done, correctly out of scope for this batch

Everything in Phases 2-7: the row schema (`packages/schemas`), admin-token
auth middleware, request-shape/size-limit handling, the import service, the
route, and all live integration tests. No file outside `packages/db` was
touched.

## Files changed

- `packages/db/src/schema/policies.ts` — added the partial unique index
  declaration.
- `packages/db/migrations/0005_policy_number_unique_index.sql` — new
  migration (generated + down-path comment added).
- `packages/db/migrations/meta/0005_snapshot.json` — new, generated by
  `drizzle-kit generate`.
- `packages/db/migrations/meta/_journal.json` — new entry for `0005`.
- `packages/db/test/migrations/policy-number-unique-index.test.ts` — new,
  structural (task 1.1).
- `packages/db/test/migrations/live-policy-number-unique-index.test.ts` —
  new, live (task 1.5).
- `openspec/changes/policy-bulk-import/tasks.md` — tasks 1.1-1.5 checked;
  1.6 left unchecked (CI gate, unconfirmed in this environment).

## Phase 2: Row schema (`packages/schemas`) — tasks 2.1-2.5

Scope respected: `packages/schemas` only. No `apps/api` changes, no import
service, no route. `packages/schemas/package.json` still declares only
`zod` as a dependency — the zero-workspace-dependency rule is unbroken
(`pnpm run lint:deps` confirms: 112 modules, 263 dependencies, zero
violations).

### RED states confirmed (2.1-2.3)

A single test file, `packages/schemas/test/policy-import-row.test.ts`, was
written against `../src/policy-import-row.js` before that module existed.
Running `pnpm --filter @dirus/schemas test` failed the whole suite file
with:

```
Error: Failed to load url ../src/policy-import-row.js (resolved id:
../src/policy-import-row.js) in .../test/policy-import-row.test.ts. Does
the file exist?
```

This is a genuine RED — the failure is "module not found", not a
pre-existing pass or an unrelated error — and it covers all three of
2.1 (missing required fields), 2.2 (optional fields), and 2.3
(strict-on-shape) in one confirmed failing run, since all three are
assertions inside the same not-yet-collectible test file. There is no
separate per-task RED run to report; one RED covers all three because the
GREEN (2.4) is a single new file.

### GREEN (2.4)

- `packages/schemas/src/policy-import-row.ts` — `policyImportRowSchema`.
  Required fields are exactly the schema's own `NOT NULL` columns per O1:
  `insurer`, `line`, `endDate`, `phone`. Every other recognized column
  (`policyNumber`, `plate`, `premiumAmount`, `currency`, `commissionPct`,
  `startDate`, `fullName`, `docType`, `docNumber`) is `.optional()`.
  Docstring carries the `NEEDS CONFIRMATION (O1)` marker, mirroring
  `caratula.ts`'s exact phrasing ("optional on presence, strict on
  shape... see primitives.ts").
- `packages/schemas/src/primitives.ts` — checked first for a reusable phone
  primitive; none existed. Added two new primitives rather than inlining
  regexes in the row schema:
  - `phoneSchema` — optional leading `+`, 7-15 digits (E.164's own max
    length), marked `NEEDS CONFIRMATION` (no repo precedent for a strict
    phone format; `contacts.phone` is `text NOT NULL` with no DB-level
    shape constraint).
  - `commissionPctSchema` — up to 3 integer digits + 2 decimals, matching
    `policies.commissionPct`'s `numeric(5,2)` column exactly, mirroring
    the existing `copAmountSchema` (`numeric(14,2)`) precedent. This was
    not explicitly requested by the task text but follows the same
    strict-on-shape principle already applied to `premiumAmount` — using
    the generic `copAmountSchema` (up to 12 integer digits) for a
    `numeric(5,2)` column would have silently accepted values the DB
    schema itself rejects.
  - Reused existing primitives as-is for everything else:
    `isoDateSchema` (endDate, startDate), `insurerLineSchema`,
    `insurerNameSchema`, `colombianPlateSchema`, `copAmountSchema`
    (premiumAmount), `copCurrencySchema`, `fullNameSchema`,
    `colombianDocTypeSchema`, `cedulaNumberSchema`.
- `packages/schemas/src/index.ts` — added
  `export * from "./policy-import-row.js"` to the barrel; extended the
  module docstring to mention the new schema and its `NEEDS CONFIRMATION`
  status.

### Verification (2.5)

- `pnpm --filter @dirus/schemas test` — 7 test files, 72 tests, all
  passing (15 new tests in `policy-import-row.test.ts`).
- `pnpm -r run typecheck` — all 8 workspace projects clean.
- `pnpm run lint` — clean (one round of fixes needed: `it.each` refactor
  to avoid unused destructured variables — see Deviations below).
- `pnpm run lint:deps` — clean, 112 modules, 263 dependencies, zero
  violations.
- `packages/schemas/package.json` dependencies unchanged:
  `{ "zod": "^4.4.3" }` only.

### Deviations from a literal reading of `tasks.md`

1. Added `commissionPctSchema` to `primitives.ts` — not named explicitly
   in task 2.3/2.4's text (which calls out `end_date` and phone as the
   primitives to check/add), but required by the same "reuse or add to
   primitives.ts, do not inline ad hoc regex" instruction once
   `commissionPct`'s `numeric(5,2)` shape was checked against the DB
   schema and found to differ from `premiumAmount`'s `numeric(14,2)`.
2. Initial test draft used `const { field: _field, ...row } = validRow`
   destructuring-omit for the four "missing required field" tests, which
   `eslint`'s `@typescript-eslint/no-unused-vars` flagged (no
   `argsIgnorePattern` for underscore-prefixed vars in this repo's config).
   Refactored to `it.each(["insurer", "line", "endDate", "phone"])` with
   `delete row[field]`, which is also more compact and avoids repeating the
   same test body four times.

No other deviations. All five Phase 2 tasks implemented and checked.

### Not done, correctly out of scope for this batch

Everything in Phases 1 (already merged), 3-7: admin-token auth middleware,
request-shape/size-limit handling, the import service, the route, and all
live integration tests. No file outside `packages/schemas` was touched.

### Files changed

- `packages/schemas/src/policy-import-row.ts` — new, the row schema
  (task 2.4).
- `packages/schemas/src/primitives.ts` — added `phoneSchema` and
  `commissionPctSchema` (task 2.3).
- `packages/schemas/src/index.ts` — re-exported the new schema, extended
  module docstring (task 2.4).
- `packages/schemas/test/policy-import-row.test.ts` — new, 15 tests
  covering required fields, optional-on-presence, and strict-on-shape
  (tasks 2.1-2.3).
- `openspec/changes/policy-bulk-import/tasks.md` — tasks 2.1-2.5 checked,
  each with a RED/verification note.
## Phase 3: Admin-token auth middleware — proposal P2, spec "Admin Token Authentication"

**Mode**: Strict TDD, Phase 3 only, run on branch
`feat/policy-bulk-import-admin-auth`, off `main` with Phase 1's migration
already merged. Phase 2 (row schema) is in a separate open PR and was not
touched — no file under `packages/schemas` was read or edited by this
batch. Scope was held strictly to `apps/api/src/env.ts`,
`apps/api/src/middleware/admin-auth.ts`, `.env.example`, and their tests, as
instructed — no route wiring (Phase 6) and nothing added to
`apps/api/src/services/` (Phase 4's territory).

### Tasks 3.1-3.2: `ADMIN_API_TOKEN` env var

- **RED confirmed for the right reason**: added `ADMIN_API_TOKEN` to
  `apps/api/test/env.test.ts`'s `REQUIRED_VARS` list before touching
  `env.ts`. Ran `vitest run test/env.test.ts` — failed with "promise
  resolved ... instead of rejecting" on exactly the new
  `it.each`-generated case for `ADMIN_API_TOKEN`, all 7 pre-existing cases
  still passing. Confirms the RED was caused by the missing env var, not a
  broken test file.
- **GREEN**: added `ADMIN_API_TOKEN: readRequired("ADMIN_API_TOKEN")` to
  `apps/api/src/env.ts`, following the existing `readRequired` pattern
  exactly (same shape as `CHATWOOT_WEBHOOK_TOKEN` etc.), with a comment
  tracing to proposal P2 and noting the eventual C1 supersession. Added the
  matching `ADMIN_API_TOKEN=` entry to `.env.example`, alongside the
  existing Chatwoot vars, with a comment describing it as a
  `crypto.timingSafeEqual`-compared, >= 32-byte compensating control sent
  via the `X-Dirus-Admin-Token` header — mirroring `CHATWOOT_WEBHOOK_TOKEN`'s
  existing comment shape. Re-ran `vitest run test/env.test.ts`: all 8 tests
  pass.

### Tasks 3.3-3.5: `admin-auth.ts` middleware

- **RED confirmed for the right reason**: wrote
  `apps/api/test/middleware/admin-auth.test.ts` mirroring
  `webhook-auth.test.ts`'s exact convention (a spy on a fake downstream
  handler proving nothing runs on rejection) before creating
  `admin-auth.ts`. Ran `vitest run test/middleware/admin-auth.test.ts` —
  failed at collection with "Failed to load url
  ../../src/middleware/admin-auth.js ... Does the file exist?", i.e. failed
  because the module genuinely did not exist yet, not a typo in the test.
- **GREEN**: wrote `apps/api/src/middleware/admin-auth.ts`, copying
  `webhook-auth.ts`'s `constantTimeEquals` helper and its length-check
  reasoning verbatim (the length check does not leak information here
  specifically because `expectedToken` is a fixed-length, server-configured
  secret never derived from user input). **One deliberate difference from
  `webhook-auth.ts`, per the task brief**: the token is read from the
  `X-Dirus-Admin-Token` header only, with no `c.req.param("token")`
  fallback. `webhook-auth.ts`'s path-segment fallback exists because
  Chatwoot may only permit configuring a URL — a third-party-caller
  constraint. Proposal P2 names only a header for this endpoint, and an
  admin caller invoking it directly can always set a header, so the
  fallback was not copied. The test suite includes a dedicated negative
  case (`"does not accept a valid token via a URL path segment"`) proving
  this by construction, not just by omission. Re-ran
  `vitest run test/middleware/admin-auth.test.ts`: all 5 tests pass.
- **One-file-swap constraint (proposal P2) honored by construction**: no
  auth logic was added to any route or service file — `admin-auth.ts` is
  the only file touched that contains token-comparison logic. Nothing in
  `apps/api/src/services/` was created or modified (Phase 4's territory,
  explicitly out of scope for this batch).

### Task 3.6: verification

- `pnpm --filter @dirus/api test`: 8 files passed, 2 skipped (live suites,
  unaffected) — 33 passed | 8 skipped, including the new
  `test/env.test.ts` (8/8) and `test/middleware/admin-auth.test.ts` (5/5).
  No pre-existing test regressed.
- `pnpm --filter @dirus/api typecheck` (`tsc -p tsconfig.json --noEmit`):
  clean, no output — the narrower per-task-3.6 check, run with the
  middleware in place but not yet wired into any route (route wiring is
  Phase 6).
- `pnpm run lint` (repo-wide eslint): clean, no output.
- `pnpm run lint:deps` (dependency-cruiser): clean — "no dependency
  violations found (112 modules, 263 dependencies cruised)".

### Deviations from a literal reading of `tasks.md`

None. All six Phase 3 tasks implemented as specified; no scope creep into
Phase 2, 4, 5, or 6 territory.

### Files changed (Phase 3)

- `apps/api/src/env.ts` — added `ADMIN_API_TOKEN` via `readRequired`.
- `.env.example` — added the `ADMIN_API_TOKEN=` entry with a comment
  describing its shape and purpose.
- `apps/api/src/middleware/admin-auth.ts` — new, the provisional
  admin-token auth middleware.
- `apps/api/test/env.test.ts` — extended `REQUIRED_VARS` with
  `ADMIN_API_TOKEN`.
- `apps/api/test/middleware/admin-auth.test.ts` — new, mirrors
  `webhook-auth.test.ts`'s test convention.
- `openspec/changes/policy-bulk-import/tasks.md` — tasks 3.1-3.6 checked.

### Not done, correctly out of scope for this batch

Phase 2 (row schema, separate open PR, not touched), Phase 4
(request-shape/size-limit handling, `apps/api/src/services/`), Phase 5 (the
import service), Phase 6 (route wiring — `admin-auth.ts` is not yet mounted
on any route), and Phase 7 (live integration tests).

## Phase 4: Request-shape and size-limit handling (`apps/api`) — tasks 4.1-4.8

Scope respected: only `apps/api/src/services/import-policies.ts` (new) and
its test. **No route wiring** (Phase 6 — nothing mounted in `app.ts` or
`index.ts`), **no row-level upsert/find-or-create/policy-upsert logic**
(Phase 5). This phase builds exactly the guards that must reject BEFORE any
row-level work: `brokerId` presence, file size, row count, broker
existence, required headers. Pure offline work — no database anywhere in
this phase; broker existence is an injected `resolveBrokerExists` fake
(`ResolveBrokerExists = (brokerId: string) => Promise<boolean>`), mirroring
`middleware/tenant-resolver.ts`'s `ResolveBrokerId` injection convention
exactly. `admin-auth.ts` (Phase 3, separate not-yet-merged branch) was not
touched, referenced, or depended on — no test in this batch uses any auth
mechanism at all.

### Note on branch chaining (Phase 2 dependency)

This batch runs on `feat/policy-bulk-import-request-shape`, chained off
`feat/policy-bulk-import-row-schema` (Phase 2, not yet merged into `main`).
Task 4.7-4.8's required-header check imports Phase 2's actual
`policyImportRowSchema` from `@dirus/schemas` — never a re-derived/hardcoded
required-field list — so `pnpm --filter @dirus/schemas test` was re-run
unmodified as part of this batch's verification (72/72 still green) to
confirm Phase 2's own suite was not disturbed by anything in this phase.

### RED states confirmed (4.1, 4.2, 4.3, 4.5, 4.7)

A single test file, `apps/api/test/services/import-policies.test.ts`, was
written against `../../src/services/import-policies.js` before that module
existed. Running `pnpm --filter @dirus/api test` failed with:

```
Error: Failed to load url ../../src/services/import-policies.js (resolved
id: ../../src/services/import-policies.js) in
.../test/services/import-policies.test.ts. Does the file exist?
```

Module-not-found, not a stale-assertion false negative — the same
convention Phase 2's 2.1 used. This single RED run covers all five
RED-marked tasks (4.1, 4.2, 4.3, 4.5, 4.7) since each is a separate `it()`
in the same not-yet-collectible file; the GREEN (4.4/4.6/4.8) is one new
module, so there is no separate per-task RED run to report, matching Phase
2's precedent for the same reason.

### GREEN (4.4, 4.6, 4.8)

- `apps/api/src/services/import-policies.ts` — one exported function,
  `runImportGuards(input, { resolveBrokerExists })`, running the checks in
  this order: `brokerId` presence -> file size (`MAX_IMPORT_FILE_SIZE_BYTES
  = 5 MB`) -> row count (`MAX_IMPORT_ROW_COUNT = 5000`, via a private
  guard-only `splitCsvLines` line splitter) -> broker existence -> required
  headers. Returns a discriminated union (`ImportGuardRejection` with
  `status: 400 | 404` and an `error` string, or `ImportGuardPass` with the
  parsed `header`/`dataRows` for Phase 5 to consume).
- `splitCsvLines` is explicitly documented as NOT Phase 5's real parser —
  a minimal newline/comma splitter sufficient only to read header names and
  count rows for these guards. Phase 5 (task 5.1-5.3, proposal O4) picks a
  real CSV/XLSX library for actual per-field row parsing; this function is
  never reused for that.
- `REQUIRED_HEADERS` (task 4.7-4.8) is derived at module load from
  `Object.entries(policyImportRowSchema.shape).filter(([, f]) =>
  !f.isOptional()).map(([k]) => k)` — imported directly from
  `@dirus/schemas`. This is the exact mechanism the task brief called for:
  if Phase 2's schema and this check ever drift, the failure mode is a
  broken import or a type error, never a silently-stale duplicate list.
  Confirmed the derived set equals `["insurer", "line", "endDate",
  "phone"]` via the "passes a well-formed request" test's header-round-trip
  assertion.

### How the two load-bearing assertions were verified (per the task brief's explicit ask)

- **Task 4.3's ordering assertion**: the test spies on
  `policyImportRowSchema.safeParse` — the actual, real export from
  `@dirus/schemas`, not a stand-in or a locally-defined fake — via
  `vi.spyOn(policyImportRowSchema, "safeParse")`, submits a 5,001-row CSV
  fixture, and asserts `expect(safeParseSpy).not.toHaveBeenCalled()` after
  confirming the rejection. This proves the row-count guard's
  count-then-reject step never reaches per-row Zod validation, structurally
  — not merely that the eventual HTTP-shaped result is a 4xx-equivalent.
  The same spy-and-assert pattern was applied to the 4.2 (size-limit) test
  for the same reason, even though the task text only required it for 4.3.
- **Task 4.5's log-line content assertion**: `vi.spyOn(console, "error")`
  asserts both `toHaveBeenCalledTimes(1)` and
  `toHaveBeenCalledWith("policy_import_unknown_broker", { brokerId:
  "unknown-broker" })` — an exact-args assertion, not just "was called" —
  plus a negative-match assertion on the joined logged text
  (`not.toMatch(/Sura|auto|2027|\+57/)`, the fixture's actual file-content
  values) mirroring `tenant-resolver.test.ts`'s negative-assertion
  convention for the same scenario shape.

### Verification

- `pnpm --filter @dirus/api test` — 8 test files, 33 passed, 8 skipped (2
  pre-existing live files, unaffected); the new
  `test/services/import-policies.test.ts` — 6/6 passing.
- `pnpm --filter @dirus/schemas test` — 72/72 passing, unmodified by this
  batch (confirms Phase 2's suite still passes as-is, per the branch-chain
  note above).
- `pnpm -r run typecheck` — all 8 workspace projects clean.
- `pnpm run lint` — clean, no output.
- `pnpm run lint:deps` — clean, "no dependency violations found (114
  modules, 267 dependencies cruised)".

### Deviations from a literal reading of `tasks.md`

1. Task 4.4's text allows "a single reusable function or pair of
   functions" — implemented as a single function (`runImportGuards`)
   rather than a pair, since the size and row-count guards share the same
   parse-and-short-circuit control flow and splitting them would have
   required either parsing the file twice or threading intermediate state
   between two exported functions for no behavioral benefit.
2. The 4.2 (size-limit) test also asserts the `safeParse` spy is never
   called, which the task text only explicitly required for 4.3 — added
   for the same structural reason (a size-limit rejection must also never
   reach per-row validation) and to keep both size-based and count-based
   file-level rejections held to the same evidentiary standard.

No other deviations. All eight Phase 4 tasks implemented and checked.

### Not done, correctly out of scope for this batch

Phase 3 (admin-token auth middleware — separate, not-yet-merged branch, not
referenced or depended on here). Phase 5 (the import service: CSV/XLSX
parsing library, per-row Zod validation loop, contact find-or-create,
policy upsert, `withBrokerContext` wiring) — `runImportGuards`'s
`ImportGuardPass.header`/`dataRows` output is designed to feed directly
into Phase 5's per-row loop, but that loop does not exist yet. Phase 6 (the
route: no `apps/api/src/routes/admin/` directory or file was created, and
neither `app.ts` nor `index.ts` was touched). Phase 7 (live integration
tests).

### Files changed

- `apps/api/src/services/import-policies.ts` — new: `runImportGuards`,
  `MAX_IMPORT_FILE_SIZE_BYTES`, `MAX_IMPORT_ROW_COUNT`, and supporting
  types (tasks 4.4, 4.6, 4.8).
- `apps/api/test/services/import-policies.test.ts` — new, 6 tests covering
  tasks 4.1, 4.2, 4.3 (with the ordering spy), 4.5 (with the log-content
  spy), 4.7, and one pass-through success case.
- `openspec/changes/policy-bulk-import/tasks.md` — tasks 4.1-4.8 checked,
  each with a RED/verification note.
