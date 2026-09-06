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

## Phase 5: The import service (`apps/api`) — tasks 5.1-5.24

All 24 tasks implemented and checked. This phase was applied on
`feat/policy-bulk-import-service`, chained off Phase 4's not-yet-merged
`feat/policy-bulk-import-request-shape` (PR #36) — `runImportGuards`'s
`{ header, dataRows }` output is this phase's conceptual input, though the
route wiring that would actually pass one into the other is Phase 6's job,
out of scope here.

### Task 5.1 — parser choice

`papaparse` (CSV) + `xlsx`/SheetJS (XLSX), both added as plain `apps/api`
dependencies (`pnpm add papaparse xlsx` + `@types/papaparse` as a
devDependency) — proposal P7/O4, no architectural stakes. Neither goes in
`packages/schemas` (zod-only) or `packages/integrations` (service clients,
not file-format libraries).

### A structural deviation from a literal one-file reading of tasks.md: two files, not one

Task 5.24's own text says "the guards and the per-row loop can coexist in
one file, or split if it gets unwieldy, your call." Adding the per-row
loop's `@dirus/db` import (`withBrokerContext`, `schema`) to
`import-policies.ts` directly broke both of Phase 4's existing offline test
files (`import-policies.test.ts`, `import-policies-parse.test.ts`) — not
with a test failure, but with an immediate `DATABASE_URL is required`
throw AT IMPORT TIME, because `@dirus/db`'s `internal/client.ts` module
guard (design.md D-A/D-B) fires the instant any module imports `@dirus/db`,
regardless of which function is actually called. Discovered by running the
full `apps/api` suite after adding the per-row loop — both offline suites
went from "9 passed" to "2 failed", pointing at
`packages/db/src/tenant.ts:3` in the stack trace.

Fix: split the per-row loop, its types, and its `@dirus/db` import into a
new file, `apps/api/src/services/import-policies-writer.ts`, which imports
only the plain `ParsedRow` type from `import-policies.ts`. `import-
policies.ts` itself (guards + parsing) now has zero `@dirus/db` in its
import graph, exactly like `runImportGuards`'s own pre-existing docstring
already promised ("this module — and everything that calls it — stays
offline-testable with a fake"). Both existing offline test files went back
to green immediately after the split, confirmed by rerunning
`pnpm --filter @dirus/api test`.

### Tasks 5.2/5.3 — file parsing (RED/GREEN, run for real, offline)

**RED**: `apps/api/test/services/import-policies-parse.test.ts` — 4 tests
calling `parseImportFile` before it existed. Ran: `TypeError: parseImportFile
is not a function` (4 failures, exact error confirmed).

**GREEN**: implemented `parseImportFile` (extension-dispatch: `.csv` ->
`Papa.parse(text, { header: true, skipEmptyLines: true })`, `.xlsx`/`.xls`
-> `XLSX.read` + `sheet_to_json`), both producing the same
`{ header: string[]; rows: Record<string, string>[] }` shape. Ran: 4/4
green. Triangulated with a 3-test set: single-row CSV, an XLSX fixture
built with `XLSX.utils.aoa_to_sheet`/`book_append_sheet`/`XLSX.write`
proving format-equivalence (not just "CSV works"), a multi-row CSV proving
row order is preserved, and an unsupported-extension rejection.

### Tasks 5.4-5.24 — the per-row loop and its live tests

**Not run here — no Postgres reachable.** Verified before writing any live
test: `docker info` reports `failed to connect to the docker API at
unix:///Users/khriztianmoreno/.orbstack/run/docker.sock ... no such file or
directory` (OrbStack's daemon is not running); `podman`/`psql`/`pg_ctl` are
not installed; `LIVE_TEST_DATABASE_URL` is unset. Every test below is
written and included in the suite as `describe.skipIf(!liveUrl)`, confirmed
to report SKIPPED (not erroring, not silently omitted) by running
`pnpm --filter @dirus/api test` after writing the file — see Verification
below.

**Production code, written and typechecked, in
`apps/api/src/services/import-policies-writer.ts`:**

- `upsertContact` — task 5.10's fill-blanks-only upsert:
  `ON CONFLICT (broker_id, phone) DO UPDATE SET full_name = COALESCE(contacts.full_name, EXCLUDED.full_name)`,
  identically for `doc_type`/`doc_number`. The existing column is the FIRST
  `COALESCE` argument, so a non-null existing value wins over the
  spreadsheet's value whether the spreadsheet cell is blank OR simply
  different (task brief's explicit "not just blank doesn't erase, but
  differing doesn't overwrite either" — tests 5.7 and 5.8 are separate
  fixtures for exactly this distinction).
- `upsertPolicy` — task 5.16's idempotent upsert keyed on
  `(broker_id, policy_number)` when present (full field overwrite, per spec
  "update the matching row's fields otherwise" — deliberately NOT
  fill-blanks-only, unlike contacts), task 5.18's mismatch check (a
  `SELECT` for the existing `(broker_id, policy_number)` row's `contact_id`
  BEFORE the `INSERT ... ON CONFLICT`, throwing a typed `RowImportError` if
  it differs from the row's resolved `contact_id` — application code, not a
  DB constraint, per the task's explicit instruction since no unique
  constraint on `contact_id` alone exists), and task 5.21's unconditional
  `INSERT` (never through `ON CONFLICT`) for a row with no `policy_number`,
  carrying `NON_IDEMPOTENT_ROW_WARNING`.
- `normalizeBlankCells` — a normalization step not explicitly named by any
  single task number but required for tasks 5.7/5.9 to be satisfiable at
  all: a blank spreadsheet cell parses as an empty string (CSV/XLSX have no
  "undefined" concept), but `policyImportRowSchema`'s optional fields
  (Phase 2) are `.optional()` at the key level only —
  `z.string().trim().min(2).optional()` still rejects an empty STRING, it
  only accepts an absent KEY. Without this step, a blank `full_name` cell
  would fail Zod validation (the row would fail) rather than being treated
  as "not provided" (spec: "A blank spreadsheet field does not erase
  existing contact data"). Maps every `""` cell value to `undefined` before
  `policyImportRowSchema.safeParse`.
- `importPolicyRows` — the per-row loop (task 5.5) and the transaction
  nesting (task 5.24), detailed below.

#### Task 5.24 — transaction nesting, verified against `tenant.ts`'s actual reentrancy guard, not just its docstring

Read `packages/db/src/tenant.ts` in full before writing `importPolicyRows`,
per the task brief's explicit instruction. The guard
(`inBrokerContext.getStore()`) throws if `withBrokerContext` is called while
an `AsyncLocalStorage` context from an outer `withBrokerContext` call is
still active — it does not care whether the SAME brokerId is passed again,
it throws unconditionally on any nested call. `importPolicyRows` therefore
calls `withBrokerContext(brokerId, ...)` exactly ONCE, at the top, for the
whole file import. Inside that one callback, each row's `processRow` call
is wrapped in `tx.transaction((rowTx) => processRow(rowTx, brokerId, row))`
— `tx` here is the broker-scoped transaction client `withBrokerContext`
handed to the outer callback, and `.transaction(...)` is a method ON that
same client, not a second call to `withBrokerContext`.

Verified this is a real nested-transaction primitive, not just a
plausible-looking method name, by reading
`drizzle-orm/node-postgres/session.js` directly (not assumed from the
type signature): its nested `transaction()` implementation issues
`savepoint sp{n}`, runs the callback, then `release savepoint sp{n}` on
success or `rollback to savepoint sp{n}` on the callback throwing — a real
Postgres `SAVEPOINT`, confirming the loop's per-row isolation claim is
backed by an actual database primitive, not an assumption about drizzle's
API surface. On a row's rejection (either a `RowImportError` app-level
mismatch, or an unexpected DB error), only that row's savepoint rolls back;
the outer transaction and every other row's already-applied work in it are
untouched, and the loop proceeds to the next row. A `RowImportError` is
caught into a `"failed"` row result; any OTHER exception type is deliberately
re-thrown out of `importPolicyRows` entirely rather than silently absorbed
into a per-row failure — an unexpected DB error is a real bug, not a
per-row validation outcome, matching this codebase's fail-loud stance
elsewhere (e.g. `tenant-resolver.ts` never guesses on ambiguity).

#### Task 5.11/5.12 — the consent test's verification convention

Followed the task brief's instruction to check `packages/schemas`/F2 tests
for precedent on asserting against generated SQL. `import-policies.live
.test.ts`'s dedicated consent test spies on `pg`'s `Client.prototype.query`
(the method every checked-out `PoolClient` shares — `pg-pool` hands out
real `Client` instances internally) and inspects every call's
`.text`/string argument for a `consent_at` reference, asserting it appears
in NONE of them — not merely that `contacts.consent_at IS NULL` afterward,
which a coincidentally-correct implementation could also produce. The test
also asserts a POSITIVE control (at least one spied call matches
`insert into "?contacts"?`) so the negative assertion is not vacuous.

**Verification convention used: mutation testing, disclosed as
UNCONFIRMED, per task 5.12's own fallback clause.** `consent_at` is
unreachable by construction — `PolicyImportRow` (Phase 2) has no
`consent`/`acepta_terminos` field to parse in the first place, so a literal
RED-before-GREEN on `upsertContact` would have been trivially true for the
wrong reason (the function didn't exist yet, not because of anything
consent-specific). The task file explicitly names this exact case as an
instance where the `extraction-schemas` mutation convention applies:
temporarily add `consentAt: sql\`now()\`` to `upsertContact`'s `.set()`,
confirm the test fails, then revert. **This mutation pass could not be
executed in this environment** (no live Postgres reachable to run either
the original test or the mutated version) — stated explicitly in the test
file's own docstring as a required follow-up for whoever runs this suite in
CI and finds it green on first execution, mirroring
`ingest-message.live.test.ts`'s and `live-policy-number-unique-index.test.ts`'s
own disclosed-mutation conventions for the same underlying reason (no
Postgres in this environment, full stop).

#### Live-test fixture conventions — the two named pitfalls, both avoided by construction here

The task brief named two exact defects from `whatsapp-webhook-ingress`'s
Phase 5 that cost that change two CI round-trips: (1) seeding as a role
bound by `FORCE ROW LEVEL SECURITY` instead of `admin`, and (2)
broker-wide assertions leaking across shared `it()` state.

`import-policies.live.test.ts` avoids (1) structurally, not by seeding
discipline: it follows `live-policy-number-unique-index.test.ts`'s
precedent (explicitly named as the closer match in the task brief) rather
than `ingest-message.live.test.ts`'s OWNER/APP-role RLS split —
`0002_rls_policies.sql` (the migration that applies `FORCE ROW LEVEL
SECURITY` to `brokers`) is never applied in this suite at all, because
Phase 5's own task list has no RLS-crossing assertion to make (that's
Phase 7's job, spec "Import Runs Within withBrokerContext and Respects
RLS"). One dedicated throwaway role (`policy_import_app`, created/dropped
in this file's own `beforeAll`/`afterAll`) exists purely so
`importPolicyRows`'s real `@dirus/db` connection has a real login to
connect as — not to prove or bypass any RLS policy.

(2) is avoided by fixture discipline: every `it()` creates its OWN broker
(`insertBroker(admin, "Broker 5.N")`) and its own contacts/policies, and
every assertion is scoped by that test's own `brokerId`/`policyNumber`/
`phone` values (e.g. `WHERE broker_id = $1 AND policy_number = $2`, never a
bare `WHERE broker_id = $1` count that could pick up another `it()`'s rows
sharing the same throwaway schema).

### Verification

- `pnpm --filter @dirus/api test` — 12 test files: 9 passed, 3 skipped (2
  pre-existing live files + the new `import-policies.live.test.ts`, 13
  tests, all skipped as expected); 37 passed, 21 skipped overall. The new
  offline `import-policies-parse.test.ts` — 4/4 passing.
- `pnpm -r run typecheck` — all 8 workspace projects clean, including the
  new `import-policies-writer.ts` and its `@dirus/db`/`drizzle-orm` usage.
- `pnpm run lint` — clean, no output.
- `pnpm run lint:deps` — clean, "no dependency violations found (119
  modules, 282 dependencies cruised)".
- `pnpm -r run test` (full workspace) — every package green: `packages/db`
  100 passed/34 skipped (its own pre-existing live suites, unaffected by
  this batch), `packages/schemas` 72/72, `packages/integrations` 7/7,
  `apps/api` 37 passed/21 skipped, `apps/dashboard`/`apps/jobs`/
  `packages/agents` no test files (unaffected, pre-existing state).

### Blocked / unverified in this environment

Every live test in this phase (5.4, 5.6-5.9, 5.11, 5.13-5.15, 5.17,
5.19-5.20, 5.22 — 13 tests in `import-policies.live.test.ts`) is
**unconfirmed here**: no Postgres, Docker, or Podman daemon is reachable
(verified directly, not assumed — see Task 5.2/5.3 section above for the
exact `docker info` failure). They report SKIPPED, not passing, in this
environment's test run. Given this is the largest and most complex phase
in this change, per the task brief's own framing, a CI round-trip fixing a
real fixture defect (a typo in a column name, an off-by-one in a
`row`-number assertion, a savepoint-nesting edge case not visible from code
reading alone) is a real possibility and should be budgeted for, mirroring
`whatsapp-webhook-ingress`'s own Phase 5 precedent. The consent test's
mutation-testing pass (5.12) additionally needs to be performed once in an
environment with a real Postgres connection before this suite's green
result (if first-run green) can be trusted as a real regression guard, not
a false negative — see the dedicated section above.

### Deviations from a literal reading of `tasks.md`

1. Split `import-policies.ts` into two files (`import-policies.ts` for
   guards/parsing, `import-policies-writer.ts` for the per-row loop) —
   task 5.24's own text explicitly permits this ("or split if it gets
   unwieldy, your call"), and the split was load-bearing, not stylistic:
   see the dedicated section above.
2. Added `normalizeBlankCells`, not named by any single task, but required
   for tasks 5.7/5.9 to be satisfiable given Phase 2's schema shape — see
   its dedicated bullet above.
3. `import-policies.live.test.ts` follows `live-policy-number-unique-index
   .test.ts`'s single-role convention (no OWNER/APP RLS split), per the
   task brief's explicit steer, rather than `ingest-message.live.test.ts`'s
   convention — a deliberate, disclosed deviation from that file's shape,
   the same kind `live-policy-number-unique-index.test.ts` itself already
   discloses relative to `live-rls-verification.test.ts`.

No other deviations. All 24 Phase 5 tasks implemented and checked.

### Not done, correctly out of scope for this batch

Phase 6 (the route: no `apps/api/src/routes/admin/` directory or file was
created; `app.ts`/`index.ts` were not touched — this phase's tests call
`importPolicyRows`/`parseImportFile`/`runImportGuards` directly, never
through HTTP). Phase 7 (live integration tests for cross-tenant RLS
isolation, CSV/XLSX end-to-end via the real route, and the 401-writes-
nothing proof).

### Files changed

- `apps/api/package.json` — added `papaparse`, `xlsx` dependencies and
  `@types/papaparse` devDependency (task 5.1).
- `apps/api/src/services/import-policies.ts` — added `parseImportFile`,
  `ParsedImportFile`, `ParsedRow`, `ParsedImportResult`, `parseCsv`,
  `parseXlsx` (tasks 5.1-5.3); `runImportGuards` and its Phase 4 exports
  unchanged.
- `apps/api/src/services/import-policies-writer.ts` — new: the per-row
  loop (`importPolicyRows`), `upsertContact`, `upsertPolicy`, `processRow`,
  `normalizeBlankCells`, `RowImportError`, `NON_IDEMPOTENT_ROW_WARNING`,
  and the `ImportRow*`/`ImportPoliciesResult` types (tasks 5.4-5.24).
- `apps/api/test/services/import-policies-parse.test.ts` — new, 4 tests
  covering tasks 5.2-5.3, run and passing offline.
- `apps/api/test/services/import-policies.live.test.ts` — new, 13 tests
  covering tasks 5.4, 5.6-5.9, 5.11-5.12, 5.13-5.15, 5.17-5.18, 5.19-5.20,
  5.22-5.23; all `describe.skipIf(!LIVE_TEST_DATABASE_URL)`, confirmed
  SKIPPED (not erroring) in this environment.
- `openspec/changes/policy-bulk-import/tasks.md` — tasks 5.1-5.24 checked.

## Phase 6: The route + response shape

Pure composition, run fully offline (no database needed for this phase's
own tests) per the tasks brief's environment note.

### Task 6.1 — RED

`apps/api/test/routes/admin/policies-import.test.ts` was written entirely
against a not-yet-created `apps/api/src/routes/admin/policies-import.ts`.
Before that module existed, `pnpm --filter @dirus/api test -- policies-import`
failed the whole file with "Failed to load url
../../../src/routes/admin/policies-import.js" — module-not-found, the same
RED convention every prior phase in this change used (Phase 2's 2.1, Phase
4's 4.1, etc.): a real absence, not a stale assertion producing a false
negative.

### Task 6.2 — GREEN: the route as pure composition

`registerAdminPoliciesImportRoute(app, { adminToken, resolveBrokerExists,
importPolicyRows })` wires, in order: `createAdminAuthMiddleware` (Phase 3,
unmodified) → multipart body parsing → a raw byte-size check (before any
parsing, spec "no row is parsed") → `parseImportFile` (Phase 5, unmodified)
→ `runImportGuards` (Phase 4, unmodified) → `importPolicyRows` (Phase 5,
injected, unmodified) → `c.json(result, 200)`. None of Phase 3's
`admin-auth.ts`, Phase 4's `import-policies.ts`, or Phase 5's
`import-policies-writer.ts` were edited in this phase — confirmed by `git
diff --stat` showing zero changes to those three files.

**The CSV/XLSX format-bridging problem, and how it was solved without
touching Phase 4's code.** `runImportGuards`'s row-count/required-header
checks (Phase 4) operate on `file.text` via its own CSV-only
`splitCsvLines` line splitter — by design (that file's own docstring calls
it "guard-only", CSV-shaped). But Phase 5's `parseImportFile` must run for
BOTH CSV and XLSX to produce the typed rows the import service consumes.
Rather than teach `runImportGuards` about XLSX (which the scope explicitly
forbids — "do not modify... the import service's logic"), the route calls
`parseImportFile` first (after the raw byte-size guard, so an oversized
file of EITHER format is still rejected before any parsing happens), then
reconstructs a minimal CSV-shaped text body — `toGuardCsvText(header,
dataRowCount)` — from the ALREADY-PARSED header and row count, and feeds
that synthetic text into `runImportGuards`. This works because
`runImportGuards` never inspects row cell VALUES, only header column names
and the data-row COUNT (verified by reading its implementation): a
reconstructed body with the real header and one blank line per real row
satisfies its contract exactly, for either source format, without any
change to Phase 4's file. This is glue code local to the route, not a
reimplementation of guard logic — the actual `brokerId`/size/row-count/
broker-existence/header decisions and their exact error messages still
come entirely from `runImportGuards` itself.

A missing-file request is also delegated to `runImportGuards` (passing
`file: undefined`) rather than the route inventing its own message, for the
same "guards own their own wording" reason — the route only needs a real
`File` object before it can measure/parse one, so that one check happens in
the route, but the rejection response comes from Phase 4's function.

An unsupported file extension (`parseImportFile` throwing) is the one new
file-level rejection this phase adds outright, since Phase 4 has no
required-header check for that — this is squarely "unparseable file",
explicitly named as an accepted file-level 4xx in the spec's Response
Reports requirement.

### Task 6.3 — the 4xx-vs-200 status discipline: RED (via 6.1's
module-not-found) AND mutation-tested

The dedicated test "6.3: EVERY row failing is still HTTP 200, never a 4xx,
once the file itself is authorized and well-formed" feeds a well-formed,
authorized 2-row file where BOTH rows fail (a fake `importPolicyRows`
returns `totals.failed = 2`, `inserted = 0`), and asserts `res.status ===
200`.

RED-before-GREEN in the literal sense already held for this test the same
way it held for 6.1 (module-not-found before the route existed), but per
the task's own instruction ("this must be a real assertion... not just
implied by the control flow"), a mutation pass was also run explicitly:

1. Temporarily changed the handler's final line from
   `return c.json(result, 200);` to
   `return c.json(result, result.totals.failed > 0 ? 422 : 200);`.
2. Re-ran `pnpm --filter @dirus/api test -- policies-import`. **Both**
   6.1's mixed-outcome test and the dedicated all-rows-fail test failed
   with `AssertionError: expected 422 to be 200` — confirming the mutation
   is caught by real assertions, not passing vacuously.
3. Reverted the line to `return c.json(result, 200);` and re-ran the same
   command: all 8 tests green again.

This directly demonstrates the property task 6.3 asks for: nothing after
the per-row loop inspects `result.totals.failed` to change the status
code, and a test exists that would catch it if something did.

Separately, four composition tests confirm every FILE-level rejection this
route can produce is a 4xx: wrong/missing admin token → 401 (import
service never called), missing `brokerId` → 4xx, unknown `brokerId` → 404,
missing required header → 4xx — each asserting the injected
`importPolicyRows` fake is never invoked, proving the rejection happens
before Phase 5's write path is ever reached.

### Task 6.4 — real wiring, plus one necessary addition

`apps/api/src/app.ts`'s `CreateAppOptions` gained three fields —
`adminToken`, `resolveBrokerExists`, `importPolicyRows` — and `createApp`
now calls `registerAdminPoliciesImportRoute(app, { ... })` alongside the
existing health/webhook routes. `apps/api/src/index.ts` wires the real
values: `env.ADMIN_API_TOKEN` (already added in Phase 3), the real
`importPolicyRows` export from `import-policies-writer.ts`, and — the one
piece that did not yet exist — a real `resolveBrokerExists`.

**Why a new `@dirus/db` export was necessary, and why it stays narrow.**
Phase 4 defined the `ResolveBrokerExists` injection point
(`(brokerId: string) => Promise<boolean>`) specifically so Phase 6 could
wire in a real implementation later — but no such implementation existed
anywhere in `@dirus/db`. `resolveBrokerIdByWaPhoneNumberId` (F2's D-7
narrow-access class) resolves a DIFFERENT key (`wa_phone_number_id`, not
`id`) via a dedicated `SECURITY DEFINER` function and role
(`0004_tenant_resolver.sql`) — reusing that mechanism for a by-id existence
check would mean either widening that function's contract or writing an
entirely new migration + role + policy, which is exactly the kind of new,
unproven mechanism Phase 1's own note says this change does NOT need
("`withBrokerContext` is already proven and reused as-is").

So `packages/db/src/broker-existence.ts` adds `brokerExists(brokerId)`
using `withBrokerContext` directly — the same `TenantDb` handle every other
table read in this codebase already uses. This works because `brokers`'s
own RLS policy (`0002_rls_policies.sql`) is self-referencing:
`USING (id = current_setting('app.broker_id'))`. Scoping the read to the
CANDIDATE id being checked IS the existence check — if a broker with that
id exists, RLS makes exactly that one row visible under its own id's
context; if it does not, the SELECT returns zero rows regardless. No new
SQL, no new migration, no new role.

A malformed (non-UUID) `brokerId` is caught via `assertUuid` and mapped to
`false` rather than propagating the throw — `runImportGuards` treats
"malformed" and "well-formed-but-absent" identically (both are spec's 404
"unknown brokerId"), never surfacing an unhandled 500 for a garbage
`brokerId` form field.

Verification convention for `brokerExists` itself: fully offline,
`vi.doMock("../src/internal/client.js", ...)`, mirroring
`tenant.test.ts`/`tenant-resolution.test.ts`'s established convention —
RED confirmed via module-not-found before the file existed, then GREEN
with 3 tests (malformed UUID → false, no transaction opened; matching row
→ true; no matching row → false). `withBrokerContext`'s own
transaction/RLS-scoping mechanics are already proven elsewhere (`tenant
.test.ts`, the live RLS suites); this file only proves `brokerExists`
calls that proven mechanism correctly.

**Barrel surface**: `brokerExists` was added to `src/index.ts`'s exhaustive
runtime-export allowlist and to `barrel-surface.test.ts`'s reviewed list —
per that test's own docstring, "the allowlist is exhaustive precisely so
that adding a new runtime export is a reviewed decision, not a silent test
edit." Updated both, with an explicit note that `brokerExists` is NOT a
D-7-style narrow-access exception (it goes through the ordinary
`TenantDb`/RLS path, not a `SECURITY DEFINER` bypass).

**Scope discipline**: `admin-auth.ts`, `import-policies.ts`, and
`import-policies-writer.ts` were not touched. The only files touched
outside the new route/test were `app.ts` and `index.ts` (wiring, per the
task) and `packages/db/src/{index,broker-existence}.ts` +
`packages/db/test/{barrel-surface,broker-existence}.test.ts` (the one
necessary addition Phase 4 deferred to this phase, documented above rather
than silently expanding scope).

### Offline-testability verification (task 6.4's explicit requirement)

A dedicated test in `policies-import.test.ts` ("offline-testability (task
6.4)") reads the route module's own source text and asserts: (a) no
`from "@dirus/db"` import appears anywhere in the file, and (b) the only
reference to `import-policies-writer.js` (which itself imports `@dirus/db`)
is a `import type` statement — i.e. erased at compile time, never reaching
this module's runtime import graph. This mirrors `app.test.ts`'s own
structural-claim-verified-by-reading-source convention rather than trusting
a docstring. `pnpm run lint:deps` (125 modules, 308 dependencies, zero
violations) additionally confirms no dependency-boundary violation was
introduced anywhere in the workspace.

### Verification

- `pnpm --filter @dirus/api test` — 11 test files: 8 passed, 3 skipped
  (pre-existing live suites, unaffected); 51 passed, 21 skipped overall.
  The new `test/routes/admin/policies-import.test.ts` — 8/8 passing.
- `pnpm --filter @dirus/api typecheck` — clean.
- `pnpm run lint` — clean, no output.
- `pnpm run lint:deps` — clean: "no dependency violations found (125
  modules, 308 dependencies cruised)".
- `pnpm -r run typecheck` — all 8 workspace projects clean.
- `pnpm -r run test` — every package green: `packages/db` 103 passed/34
  skipped (includes the new `broker-existence.test.ts`, 3/3, plus the
  updated `barrel-surface.test.ts`, 3/3), `packages/integrations` 7/7,
  `apps/api` 51 passed/21 skipped, `apps/dashboard`/`apps/jobs`/
  `packages/agents` no test files (unaffected).

### Deviations from a literal reading of `tasks.md`

1. Added `packages/db/src/broker-existence.ts` (`brokerExists`) and its
   test/barrel-surface updates — not literally named by any Phase 6 task
   text, but required for task 6.4's "wiring in... the real broker-lookup
   dependency" to be a REAL implementation rather than a stub, since no
   such implementation existed anywhere in the codebase before this phase.
   See the dedicated section above for the full reasoning and why it does
   not touch any of the three explicitly protected files.
2. `toGuardCsvText`'s CSV-reconstruction bridge in the route (see the Task
   6.2 section above) is new glue code not literally named by any task
   text, needed to let Phase 4's CSV-only guard function serve both source
   formats without modifying Phase 4's file.

No other deviations. All 5 Phase 6 tasks implemented and checked.

### Not done, correctly out of scope for this batch

Phase 7 (live integration tests: two-broker RLS isolation through the real
route, CSV/XLSX end-to-end via HTTP, the 401-writes-nothing proof) and the
`openspec/ROADMAP.md` correction (task 7.5) — both explicitly Phase 7's
job, not Phase 6's.

### Files changed

- `apps/api/src/routes/admin/policies-import.ts` — new: the route
  (tasks 6.1-6.3).
- `apps/api/test/routes/admin/policies-import.test.ts` — new, 8 tests
  covering tasks 6.1-6.3, all passing offline.
- `apps/api/src/app.ts` — `CreateAppOptions` gained `adminToken`,
  `resolveBrokerExists`, `importPolicyRows`; `createApp` now also calls
  `registerAdminPoliciesImportRoute` (task 6.2).
- `apps/api/src/index.ts` — wires `env.ADMIN_API_TOKEN`, `brokerExists`
  (from `@dirus/db`), and `importPolicyRows` (from
  `import-policies-writer.ts`) into `createApp` (task 6.4).
- `apps/api/test/app.test.ts` — `fakeOptions()` extended with the three new
  `createApp` fields; import-graph docstring updated to describe the new
  route's module graph.
- `packages/db/src/broker-existence.ts` — new: `brokerExists(brokerId)`
  (task 6.4's necessary addition, see above).
- `packages/db/src/index.ts` — exports `brokerExists`; docstring updated.
- `packages/db/test/broker-existence.test.ts` — new, 3 tests, offline,
  mirroring `tenant.test.ts`'s mocking convention.
- `packages/db/test/barrel-surface.test.ts` — allowlist extended to include
  `brokerExists`, with an explicit note on why it is not a D-7-style
  exception.
- `openspec/changes/policy-bulk-import/tasks.md` — tasks 6.1-6.5 checked.
