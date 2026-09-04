# Apply Progress: WhatsApp webhook ingress

**Mode**: Strict TDD, Phase 1 only, per the ordering constraint at the top of
`tasks.md`. Phase 1 is the gate — Phases 2-6 are explicitly out of scope for
this batch and were not touched.

**Environment constraint (verified, not assumed)**: `docker --version` shows
Docker 29.6.1 installed, but `docker info` fails — the daemon is not
reachable. No `podman` binary exists. No `pg_ctl`/`psql` binary exists. Port
5432 is closed. **No Postgres of any kind is reachable in this environment.**
The five live D-1 assertions, the catalog-guard live tests, and both mutation
tests therefore could **not** be executed here. They are written, gated
correctly (`describe.skipIf(!TENANT_RESOLVER_TEST_DATABASE_URL)`), and were
confirmed to actually skip (not silently pass) in a real `pnpm -r test` run.
**They must be proven green in CI before Phase 2 starts.** This report does
not claim otherwise anywhere.

## What was executed for real (this environment)

- `packages/db` structural test for the migration
  (`test/migrations/tenant-resolver-migration.test.ts`): **RED then GREEN,
  both actually run.** RED was confirmed by temporarily overwriting
  `migrations/0004_tenant_resolver.sql` with the empty custom-migration stub
  drizzle-kit generates (`-- Custom SQL migration file, put your code below!
  --`) and running `pnpm exec vitest run test/migrations/tenant-resolver-migration.test.ts`
  — 10 of 13 assertions failed for the right reason (content absent). The
  real migration content was then restored and the same command re-run:
  13/13 pass.
- `pnpm exec tsc -p tsconfig.json --noEmit` in `packages/db`: clean.
- `pnpm -r run typecheck` (repo-wide): clean, all 8 packages with a
  `typecheck` script.
- `pnpm run lint` (repo-wide eslint): clean.
- `pnpm run lint:deps` (dependency-cruiser): clean, "no dependency violations
  found (70 modules, 148 dependencies cruised)".
- `pnpm -r run test` (repo-wide): 92 passed, 28 skipped, 0 failed across the
  monorepo. The 28 skips are exactly the pre-existing live suites
  (`live-rls-verification.test.ts`, `rls-catalog-guard.test.ts`,
  `migrate-runner-live.test.ts`, `tenant-live-round-trip.test.ts`) plus this
  batch's new `live-tenant-resolution.test.ts` (14 tests, all skipped) —
  confirmed by reading the actual `vitest` output line-by-line, not assumed
  from the gate expression alone.
- `packages/db/test/migrations/drift.test.ts` (`drizzle-kit check`): zero
  drift — `0004_tenant_resolver.sql` was generated via
  `drizzle-kit generate --custom --name=tenant_resolver` per design.md's
  instruction, so it only appended a journal entry, not a schema diff.
- `.github/workflows/ci.yml` was validated as syntactically well-formed YAML
  via a scratch Python venv + PyYAML (`yaml.safe_load`), since no `yamllint`
  or `js-yaml` was available offline in this environment.

## What was NOT executed (must run in CI — task 1.7's gate)

- All 14 `it()`s in `packages/db/test/migrations/live-tenant-resolution.test.ts`,
  including:
  - The 5 design D-1 assertions (positive, **negative control**, miss, owner
    control, membership guard).
  - The suspended-broker-still-resolves scenario (P5).
  - The `search_path` hijack-resistance scenario (temp table shadowing).
  - 4 catalog checks (`proconfig`, `SECURITY DEFINER`/owner/return-type,
    `EXECUTE` grantee, policy `TO`-clause scoping, `tenant_isolation`
    untouched).
  - **2 mutation tests**, both written but unrun:
    1. Drops `tenant_resolver_lookup`'s `TO` clause (`FOR SELECT USING
       (true)`, no `TO`), reconnects as `dirus_app`, and asserts
       `SELECT count(*) FROM brokers` returns a non-zero count — the exact
       demonstration the "what matters most" instructions asked for, that
       the negative control is not vacuously true. Restores the correct
       policy in a `finally`.
    2. `GRANT dirus_tenant_resolver TO dirus_app` (default `INHERIT TRUE`)
       and asserts the membership-guard query then reports exactly one
       inheriting membership row for `dirus_app` — proving the catalog guard
       actually discriminates, not just that it runs. Restores with `REVOKE`
       in a `finally`.
- Because none of this ran, **D-1 remains formally unproven** in the sense
  design.md and the data-model spec use that word. The migration SQL and the
  test file both encode the reasoning correctly as far as static analysis
  and Postgres documentation can confirm, but "correct as far as I can tell
  by reading" is exactly the standard this task brief said has failed before.

## Migration: `packages/db/migrations/0004_tenant_resolver.sql`

Generated via `drizzle-kit generate --custom --name=tenant_resolver` (no DB
connection required for `--custom`; confirmed by running it against a
placeholder `DATABASE_URL_UNPOOLED`). Implements design.md D-1's sketch with
two deliberate, documented deviations from the literal sketch text:

1. **`GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;`**
   before `ALTER FUNCTION ... OWNER TO dirus_tenant_resolver`. The sketch in
   design.md omits this line, but `ALTER FUNCTION ... OWNER TO` requires the
   migration-running role to already hold membership in the target role —
   design.md's own prose says as much ("`ALTER FUNCTION ... OWNER TO`
   requires the migration role to hold that membership, so grant it `WITH
   INHERIT FALSE`") but the sketch code block never actually included the
   statement. Added it, non-inheriting, so it satisfies the data-model
   spec's membership-guard scenario by construction.
2. **The `GRANT EXECUTE ON FUNCTION ... TO dirus_app;` line is wrapped in the
   same `DO $$ IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app')
   ... $$` guard `0003_app_role_grants.sql` uses**, rather than the sketch's
   unconditional `GRANT`. `dirus_app` is provisioned out-of-band
   (`scripts/provision-app-role.sql`), never by a committed migration — an
   unconditional grant to a role that does not yet exist on a fresh clone
   would make `0004` fail exactly the way `0003`'s own header comment
   explains `0003` was designed not to. This is a direct application of an
   already-reviewed pattern in this exact codebase, not a new one.

Both deviations are called out explicitly in the migration's own comments and
in `tenant-resolver-migration.test.ts`'s assertions (which check for the
guard, not the unconditional form).

The down path (task 1.3) is a documented comment block at the end of the
file, in the exact order design.md's "Migration / Rollout" section specifies:
`REVOKE EXECUTE` → `DROP FUNCTION` → `DROP POLICY` → `REVOKE` the
column/schema grants → `REVOKE` the owner's membership → `DROP ROLE`. It is
not a second executable script — this migration sequence has no down-runner
(consistent with 0000-0003, none of which have one either).

## Test files

- `packages/db/test/migrations/tenant-resolver-migration.test.ts` (new,
  offline/structural): mirrors `rls-policies.test.ts` and
  `app-role-grants.test.ts`'s convention — SQL-text assertions against the
  committed migration file. Covers task 1.1's five declared facts plus the
  DO-block-guard deviation, the OWNER TO / INHERIT FALSE grant, the down-path
  ordering, and (scoped to just the function body, not the whole file's
  comments) the "no `status` predicate" requirement.
- `packages/db/test/migrations/live-tenant-resolution.test.ts` (new, live,
  `describe.skipIf`): implements design D-1's five live assertions verbatim
  as five separate `it()`s, plus the data-model delta spec's two additional
  live scenarios (suspended broker, search_path hijack) and its four catalog
  checks, plus the two mutation tests described above. This file also folds
  in task 1.4's catalog-guard requirements (`pg_auth_members`, `proconfig`,
  `EXECUTE` grantee) rather than extending `rls-catalog-guard.test.ts` or
  building a second disjoint sibling file — it needs the exact same fixture
  (brokers table + RLS + resolver role/policy/function) 1.6 requires anyway,
  and `tasks.md` 1.4 explicitly allows a sibling file "if scope grows large
  enough to warrant a split". This is a deliberate consolidation decision,
  recorded here since it deviates from the task's literal
  "extend rls-catalog-guard.test.ts" phrasing.

### Why this live test targets its own dedicated database, not the shared `LIVE_TEST_DATABASE_URL` throwaway-schema convention

`live-rls-verification.test.ts` and `rls-catalog-guard.test.ts` both apply
migrations to a randomly-named throwaway schema inside the shared
`dirus_test` database, using `rewriteSchemaQualification` to redirect
`0000_init.sql`'s hardcoded `"public".`-qualified FK references to that
schema. That mechanism cannot be reused here: `0004_tenant_resolver.sql`'s
`SECURITY DEFINER` function body deliberately hardcodes `public.brokers`
(unquoted, not the FK-clause `"public".` shape `rewriteSchemaQualification`
targets) — that hardcoded qualification is itself the search_path-hijack
defense design.md D-1 names as risk #2. Rewriting it to a throwaway schema
name would silently defeat the exact property the search_path-hijack test is
supposed to prove. The only correct fix would be to make
`rewriteSchemaQualification` schema-aware of arbitrary `public.` references
inside function bodies too, which risks rewriting things that must not move.

Instead, `live-tenant-resolution.test.ts` mirrors
`migrate-runner-live.test.ts`'s already-established, judge-reviewed pattern
exactly: its own dedicated, single-purpose database
(`TENANT_RESOLVER_TEST_DATABASE_URL`, wired into `.github/workflows/ci.yml`
alongside the existing `dirus_migrate_test`/`MIGRATE_RUNNER_TEST_DATABASE_URL_UNPOOLED`
pair), migrations applied directly to that database's real `public` schema,
full `DROP SCHEMA public CASCADE` + `CREATE SCHEMA public` teardown. For the
same reason, and following that same file's precedent (the only other file in
this repo that does this), this suite creates and drops a role literally
named `dirus_app` — `rls-catalog-guard.test.ts`'s Judgment Day round 4
forbids that specifically against the *shared* `dirus_test` cluster (a
crashed run could leave/drop a real deployed role sharing that cluster); this
suite's target database is its own single-purpose, fully-torn-down database,
the same shape `migrate-runner-live.test.ts` already uses that way. A literal
`dirus_app` role is also required to exercise 0004's own `pg_roles`
existence-check DO block for real, and the spec's negative-control wording
("`dirus_app` ... still sees zero rows") is about that literal role.

`.github/workflows/ci.yml` was updated to provision this second dedicated
database (`dirus_tenant_resolver_test`) and set the new env var, following
the exact same step shape the `dirus_migrate_test` database already uses.

## CI-only risk carried forward, not resolved here

design.md's own open question — "Does the migration role hold `CREATEROLE`?"
— is answered *for this test's purposes* by having the live test apply
`0004` as the `admin` (superuser) connection rather than the non-superuser
`OWNER_ROLE` fixture: `CREATE POLICY` requires table ownership or superuser,
and `CREATE ROLE`/role-membership grants require `CREATEROLE` or superuser,
so running `0004` as `admin` sidesteps needing to grant `CREATEROLE` to a
fixture role at all. **This does not answer the question for the real Neon
deployment** — whether the actual migration-applying role there holds
`CREATEROLE` remains open, exactly as design.md already flags it, and is
unchanged by this batch.

## Deviations from a literal reading of `tasks.md`

- 1.1/1.2 order: the structural test (1.1) and the migration content (1.2)
  were effectively co-designed in the same pass — the migration file's exact
  shape had to be known to write meaningful assertions. RED-before-GREEN was
  still empirically enforced by temporarily blanking the migration file back
  to the empty custom-migration stub and re-running the test (see "What was
  executed for real" above) rather than trusting that RED "would have"
  happened.
- 1.4: folded into `live-tenant-resolution.test.ts` rather than extending
  `rls-catalog-guard.test.ts` or building a fully separate sibling file — see
  the dedicated section above.
- 1.5: cannot be independently confirmed as "GREEN once applied in CI's live
  Postgres" from this environment; the assertions exist and are believed
  correct, but this is explicitly unverified, not claimed as passing.

## Not done, correctly out of scope for this batch

Everything in Phases 2-6: no `packages/db` public export
(`resolveBrokerIdByWaPhoneNumberId`), no `apps/api`, no Hono, no route
handlers, no Chatwoot payload schema, no ingest pipeline. Per the ordering
constraint at the top of `tasks.md`, none of that may start until task 1.7 is
green in CI.

---

# Phase 2: `packages/db` public surface (design D-7)

**Mode**: Strict TDD, Phase 2 only. Task 1.7 (the D-1 gate) PASSED in CI
(CI run 33899572167, referenced above) before this batch started, per the
ordering constraint. Scope strictly `packages/db`'s public surface — no
`apps/api`, no Hono, no Chatwoot schema, no route handlers (Phases 3-5).

## Recovered artifact: `packages/db/src/tenant-resolution.ts`

A prior attempt at this same phase was interrupted before finishing and left
this file untracked but written. It was NOT trusted blindly — verified
against design.md D-7 line by line before reuse:

- **Length cap**: `MAX_KEY_LENGTH = 256`. Design D-7 says only "cap its length
  to reject pathological input" without naming a number; the file's own
  docstring reasons real Meta phone-number-id values are "well under 100
  characters" and the cap exists only to reject pathological input (e.g. a
  megabyte-sized hostile string), not to validate the key's shape. 256 is a
  reasonable, generously-bounded choice for that stated purpose. Accepted
  as-is.
- **SQL call shape**: `sql\`select public.dirus_resolve_broker_id(${key})\``
  via `db.execute` on the pooled `db` from `./internal/client.js` — matches
  design D-7's sketch (`select public.dirus_resolve_broker_id($1)`) exactly:
  single statement, bound parameter, no transaction, no `withBrokerContext`.
- **Return type**: `Promise<string | null>`, verified by reading the
  implementation (`result.rows[0]?.dirus_resolve_broker_id ?? null`) and by a
  mutation test (see below) that it cannot silently start returning a row
  object without every offline test that exercises it failing.

Conclusion: correct as written. Reused verbatim, byte-for-byte — the only
changes this batch made were to `src/index.ts` and `src/tenant.ts` (the two
docstrings) and new test files. `src/tenant-resolution.ts` itself was not
edited.

## Tasks 2.1 / 2.4: barrel export, RED then GREEN (actually observed)

Extended `packages/db/test/barrel-surface.test.ts`'s exhaustive allowlist to
expect `resolveBrokerIdByWaPhoneNumberId` alongside the existing three names.

- **RED, actually run**: with the test extended but the export not yet added
  to `src/index.ts`, `pnpm exec vitest run test/barrel-surface.test.ts`
  failed for the right reason — `expected [ 'assertUuid', 'schema', …(1) ] to
  deeply equal [ 'assertUuid', …(3) ]` (the export was simply absent, not a
  wrong value).
- **GREEN, actually run**: after adding
  `export { resolveBrokerIdByWaPhoneNumberId } from "./tenant-resolution.js";`
  to `src/index.ts`, the same command passed (3/3).

## Task 2.5: both docstrings corrected

- `packages/db/src/tenant.ts` — `TenantDb`'s docstring now states it is "the
  only handle through which TABLE access is possible" (not "the only
  tenant-scoped handle callers ever receive"), and names
  `resolveBrokerIdByWaPhoneNumberId` explicitly as a second, deliberately
  narrower access class returning only an opaque identifier, with an explicit
  statement that the pattern must not be extended to any call returning row
  or column data.
- `packages/db/src/index.ts` — the barrel docstring no longer claims "every
  query a caller issues goes through the transaction-scoped tenant context"
  unconditionally; it now names `resolveBrokerIdByWaPhoneNumberId` as the
  single documented exception and explains why (tenant resolution logically
  precedes tenant context — a caller cannot scope a transaction to a
  `broker_id` it does not yet have).

## Task 2.2 / 2.6: `packages/db/test/tenant-resolution.test.ts` (new, offline)

Five tests, all against a mocked `../src/internal/client.js` (the same
`vi.doMock` + dynamic-import convention `tenant.test.ts` already established
— no new convention invented):

1. Rejects a key one character over the cap, asserting the mocked
   `db.execute` spy is never called (task 2.2).
2. Accepts a key exactly at the cap and issues the query.
3. Asserts the rendered SQL text contains
   `select public.dirus_resolve_broker_id(` and the bound parameter equals
   the input key, and that `db.transaction` is never called (proves "single
   statement, no transaction" from design D-7, not just "returns the right
   value").
4. Returns `null` for an unknown key.
5. Task 2.6's dedicated test: asserts no transaction is opened and the
   result is a `string` or `null`, never an `object`.

**Task 2.2 RED verified empirically, not just claimed**: temporarily edited
`src/tenant-resolution.ts` to raise `MAX_KEY_LENGTH` to `100000`, re-ran
`pnpm exec vitest run test/tenant-resolution.test.ts` — test 1 failed
(`Cannot read properties of undefined (reading 'rows')`, because the guard no
longer ran and the query proceeded to a spy with no return value configured
— failing for the right reason: the cap no longer rejected the input before
querying). Restored the file (confirmed byte-identical to the reused
original by re-running the full suite GREEN, 5/5) before continuing.

**Task 2.6 — RED was not attainable in the ordinary sense** (the return
type `Promise<string | null>` already makes returning a row object a
compile-time error, so no runtime input can force a meaningful RED state
without first defeating the type system) — **mutation-tested per the task's
own instruction**. Mutation performed: changed the `return` statement from
`result.rows[0]?.dirus_resolve_broker_id ?? null` to
`(result.rows[0] as unknown as string | null) ?? null` — i.e. leak the whole
row instead of unwrapping the single column. Outcome: re-running
`pnpm exec vitest run test/tenant-resolution.test.ts` failed 4 of 5 tests,
including the task 2.6 test itself (`expected false to be true` — the result
was now an object, not a `string | null`) and the "returns null for an
unknown key" test (now returned `{ dirus_resolve_broker_id: null }` instead
of bare `null`). The mutation was then reverted and the suite re-confirmed
GREEN (5/5). This is the convention documented directly in the test file's
own comment above the task 2.6 test.

## Task 2.7: the export itself, called against the live fixture

Extended `packages/db/test/migrations/live-tenant-resolution.test.ts` with a
new `describe("2.7: ...")` block (3 new `it()`s: positive resolve, unknown-key
miss, over-length rejection) that dynamically imports
`../../src/tenant-resolution.js` — the real exported function, not a raw SQL
string — authenticated as `dirus_app` against this file's existing dedicated
fixture (`TENANT_RESOLVER_TEST_DATABASE_URL`). Because `@dirus/db`'s internal
client asserts a pooled ("-pooler") host at import time (design.md D-B) and
this dedicated test database is not a Neon pooled endpoint, each `it()` sets
`ALLOW_UNPOOLED_RUNTIME=1` before the dynamic import — the same documented
override every other non-pooled fixture in this repo already uses, not a new
bypass. `vi.resetModules()` before each import (mirrors `tenant.test.ts`'s
convention) and an `afterEach` closes the `pg.Pool` opened by the dynamic
import via `../../src/internal/client.js`'s exported `pool` (imported
directly by the test file, not through the package barrel, since the barrel
deliberately never exports the raw pool — design.md D-C) so the test process
exits cleanly.

This file was gated `describe.skipIf(!liveUrl)` before this batch and remains
so; the 3 new `it()`s inherit that gate — they were not run in this
environment (see below), only added and reasoned about statically plus
typechecked.

## What was executed for real (this environment)

- `pnpm exec vitest run test/barrel-surface.test.ts` — RED then GREEN, both
  actually observed (task 2.1/2.4).
- `pnpm exec vitest run test/tenant-resolution.test.ts` — 5/5 GREEN on the
  real implementation; RED empirically confirmed for task 2.2 by temporarily
  raising the length cap (see above, then restored); mutation-tested for task
  2.6 by temporarily leaking the row object (see above, then restored).
- `pnpm exec tsc -p tsconfig.json --noEmit` in `packages/db`: clean.
- `pnpm -r run typecheck` (repo-wide, 8 packages): clean.
- `pnpm run lint` (repo-wide eslint): clean (one `no-unused-vars` finding
  during authoring, on an unused mock-callback parameter in the new test
  file, fixed by typing the mock via `vi.fn<...>` generics instead of a named
  parameter).
- `pnpm run lint:deps` (dependency-cruiser): clean — "no dependency
  violations found (72 modules, 157 dependencies cruised)".
- `pnpm -r run test` (repo-wide): 97 passed, 31 skipped, 0 failed in
  `packages/db` (up from the Phase 1 baseline of 92 passed / 28 skipped:
  +5 new offline tests in `tenant-resolution.test.ts`, all passing; the
  skipped count in `live-tenant-resolution.test.ts` rose from 14 to 17,
  confirming the 3 new task-2.7 assertions were added and are correctly
  gated, not silently dropped or silently passing).

## What was NOT executed (must run in CI)

- All 17 `it()`s in `live-tenant-resolution.test.ts`, including the 3 new
  task-2.7 assertions calling `resolveBrokerIdByWaPhoneNumberId` itself.
  **Environment verified, not assumed**: `docker info` fails (daemon
  unreachable), no `podman`/`pg_ctl`/`psql` binary exists, port 5432 is
  closed, `TENANT_RESOLVER_TEST_DATABASE_URL` is unset — no Postgres of any
  kind is reachable here, identical to the Phase 1 finding. These 3 new
  assertions must be proven green in CI before this phase is considered
  fully verified end-to-end; everything short of that (RED/GREEN on the
  offline unit test, the mutation test, typecheck, lint, lint:deps) was
  actually executed and is reported above as such, not assumed.

## Deviations from a literal reading of `tasks.md`

- 2.3 (create `tenant-resolution.ts`) was already satisfied by the recovered
  untracked file from the interrupted prior attempt; this batch verified it
  against design D-7 rather than rewriting it, per the task brief's explicit
  instruction to verify rather than trust or blindly rewrite.
- Task 2.6's test also independently re-asserts the "single statement, no
  transaction" property (already partially covered by a separate test in the
  same file) as a belt-and-suspenders check, since the mutation test's value
  depends on the transaction-spy assertion catching a hypothetical future
  `withBrokerContext` call too, not only the row-shape leak.

## Not done, correctly out of scope for this batch

Everything in Phases 3-6: no `apps/api`, no Hono, no route handlers, no
Chatwoot payload schema, no ingest pipeline, no live concurrency tests. Per
the ordering constraint at the top of `tasks.md`, this batch touched only
`packages/db`'s public surface.
