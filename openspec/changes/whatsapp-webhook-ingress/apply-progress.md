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

## Phase 3: `apps/api` bootstrap — design D-5

All ten tasks (3.1-3.10) complete. Scope held strictly to bootstrap: Hono,
env loading, `createApp` factory, health route. No webhook route, no
Chatwoot payload schema, no ingest pipeline — those are Phases 4 and 5, per
the batch brief's explicit boundary.

### Task 3.1: dependencies

Added to `apps/api/package.json#dependencies`: `hono` (^4.13.5),
`@hono/node-server` (^2.1.1), and workspace deps `@dirus/db`,
`@dirus/schemas`, `@dirus/integrations` (all `workspace:*`). `@dirus/config`
stays a devDependency (unchanged, existing convention). `pnpm install`
resolved cleanly (2 new packages added, no lockfile conflicts).

### Task 3.2/3.3: `apps/api/src/env.ts`

**RED, actually run**: wrote `apps/api/test/env.test.ts` (7 tests: one
`it.each` per required var asserting import-time throw naming that var, one
"succeeds when all present," one "loads with `DATABASE_URL` unset") before
`src/env.ts` existed. `pnpm --filter @dirus/api exec vitest run
test/env.test.ts` failed 7/7 for the right reason: `Failed to load url
../src/env.js ... Does the file exist?` — module absence, not a wrong
value, mirroring the same class of legitimate initial-RED the barrel-surface
convention in Phase 2 used.

**GREEN, actually run**: wrote `src/env.ts` — a hand-rolled `readRequired
(name)` throwing `"${name} is required (see .env.example)..."` at import
time, mirroring `packages/db/src/internal/client.ts`'s
`readDatabaseUrl`/`assertPooledHost` pattern exactly (no Zod, no lazy
getter). Re-ran the same command: 7/7 GREEN.

`env.ts` covers only `apps/api`'s own five vars (`CHATWOOT_WEBHOOK_TOKEN`,
`CHATWOOT_BASE_URL`, `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID`,
`PORT`) and has zero import of `@dirus/db`, direct or transitive — the test
file's last case asserts the module loads successfully with `DATABASE_URL`
deleted from `process.env`, which is the load-bearing proof of design D-5's
"deliberately does not re-validate `DATABASE_URL`" statement, not just an
assertion by construction.

### Task 3.4: `.env.example`

Appended a new `apps/api` section documenting all five vars, each with a
one-line note on what it's for and a pointer back to `apps/api/src/env.ts`
and design D-5/D-4 where relevant (e.g. `CHATWOOT_WEBHOOK_TOKEN` notes the
`crypto.timingSafeEqual` compensating-control framing from D-4, even though
the middleware that reads it doesn't exist until Phase 5).

### Task 3.5/3.6: `apps/api/src/app.ts`

**RED, actually run**: wrote `apps/api/test/app.test.ts` (asserts `createApp
({ ingest: fakeIngest })` constructs and routes `GET /health` to 200, and
that constructing the app never itself invokes `ingest`) and
`apps/api/test/routes/health.test.ts` before `src/app.ts` existed. Both
failed for the same "module doesn't exist" reason
(`Failed to load url ../src/app.js`), confirmed by running both files
together.

**GREEN, actually run**: wrote `src/app.ts` — `createApp({ ingest })`
constructs a `Hono<{ Variables: { ingest: Ingest } }>`, sets `c.var.ingest`
via a catch-all middleware (mirroring the `c.var.brokerId` convention design
D-5 assigns to the not-yet-written `tenant-resolver.ts` middleware, so the
Phase 5 webhook route won't need this factory's signature reshaped), then
mounts the health route. `Ingest` is typed loosely
(`(brokerId: string, payload: unknown) => Promise<unknown>`) since its real
shape belongs to Phase 5's `services/ingest-message.ts`. Re-ran both test
files: 3/3 GREEN.

Import graph verified for real, not assumed: `src/app.ts` imports only
`"hono"` and `./routes/health.js`; `src/routes/health.ts` imports only
`"hono"`'s types and `../app.js`'s `AppVariables` type (erased at compile
time, so not even a real runtime edge). Neither file imports `@dirus/db`,
`@dirus/schemas`, or `@dirus/integrations`. `pnpm --filter @dirus/api test`
was run with `DATABASE_URL` confirmed unset in the shell
(`echo "DATABASE_URL is: ${DATABASE_URL:-<unset>}"` printed `<unset>`
immediately before the run) — all 10 tests passed, which is the actual proof
design D-5's offline-testability constraint holds today, not a static
reading of the imports alone.

### Task 3.7/3.8: `apps/api/src/routes/health.ts`

RED and GREEN for this task landed together with 3.5/3.6 above (same file
creation batch, same RED run: `health.test.ts` failed for "module doesn't
exist" before `app.ts`/`health.ts` existed). GREEN: `registerHealthRoute`
mounts `GET /health` returning `{ status: "ok" }`, no auth check, no
database import anywhere in the file. The test additionally asserts the
injected fake `ingest` spy is never called by this route — the health route
provably never touches `c.var.ingest`.

### Task 3.9: `apps/api/src/index.ts`

Bootstrap order matches design D-5 literally: `import { env } from
"./env.js"` (so the fail-loud-at-import guard runs before anything else),
then `createApp({ ingest: notYetImplementedIngest })`, then
`serve({ fetch: app.fetch, port: Number(env.PORT) })`.

`notYetImplementedIngest` is a deliberately, visibly named placeholder — not
a fabricated ingest implementation. Its docstring states explicitly: (1) the
real `services/ingest-message.ts` doesn't exist yet (Phase 5), (2) no route
mounted in Phase 3 ever calls it (only `GET /health`, which never reads
`c.var.ingest`), so it is dead code at runtime today by construction, and
(3) it exists only to satisfy `createApp`'s required `ingest` parameter at
bootstrap. If invoked, it throws `"Ingest pipeline not implemented yet
(Phase 5 ...)"` rather than silently no-opping or fabricating behavior.
Task 5.22 in `tasks.md` is the one that replaces this constant with the real
import.

### Task 3.10: verification, actually run

- `pnpm --filter @dirus/api test` — 3 files, 10/10 passed, with
  `DATABASE_URL` confirmed unset in the environment beforehand (see above).
- `pnpm -r run typecheck` — all 9 workspace projects (including `apps/api`)
  clean.
- `pnpm run lint` (repo-wide eslint) — clean, no output.
- `pnpm run lint:deps` (dependency-cruiser) — clean: "no dependency
  violations found (89 modules, 189 dependencies cruised)" (up from Phase
  2's 72/157, consistent with the new `apps/api` files and their `hono`
  import edges).
- `pnpm -r run test` (repo-wide) — `packages/db` unchanged (97 passed / 31
  skipped), `apps/api` 3 files / 10 passed (new), all other packages
  pass-with-no-tests as before.

### Environment, verified not assumed

`docker info` fails ("NOT reachable"), no `podman` binary, no `psql` binary,
`nc -z localhost 5432` reports closed/unreachable. No Postgres of any kind
is reachable in this environment — consistent with Phase 1/2's findings.
This phase needed none of that: no file written in Phase 3 imports
`@dirus/db`'s runtime client, and the full test suite ran green with zero
database env vars set.

### Deviations from a literal reading of `tasks.md`

None. All ten tasks implemented as specified; no scope crept into Phase 4
(no Chatwoot schema) or Phase 5 (no webhook route, no auth middleware, no
tenant-resolver middleware, no `services/ingest-message.ts`).

### Not done, correctly out of scope for this batch

Everything in Phases 4-6: the Chatwoot payload schema in `packages/schemas`,
the webhook route, the auth/tenant-resolver middleware, the ingest pipeline
in `services/ingest-message.ts`, `packages/integrations/src/chatwoot.ts`,
and all live concurrency/isolation tests.
---

# Phase 4: Chatwoot payload schema (design D-6, spec "Raw Payload Is Not Retained Verbatim")

**Mode**: Strict TDD, Phase 4 only. Scope held strictly to `packages/schemas`
— no `apps/api` route wiring, no ingest pipeline, no persistence (Phase 5).
`apps/api/src/routes/webhooks` and `apps/api/src/middleware` were confirmed
not to exist yet (`apps/api/src` contains only `index.ts`, the empty typed
shell from workspace scaffolding — Phase 3's tasks are still unchecked), so
the isolation test (4.7) is written to hold once those directories are
created rather than assuming their current contents.

## Task 4.1 — disclosed unknown, not resolved by guessing confidently

No live Chatwoot instance or captured payload exists. Per the task's
explicit instruction, this was **not** worked around by asserting a shape
with unwarranted confidence. The fixture
(`packages/schemas/test/fixtures/chatwoot-message-created.json`) is derived
from Chatwoot's public webhook documentation
(https://www.chatwoot.com/docs/product/others/webhooks) for a
`message_created` webhook: `event`, `id`, `content`, `message_type`,
`content_type`, `source_id`, `sender`, `contact`, `conversation`, `account`,
`inbox`. The fixture carries its own `_provisional` marker key (itself
convenient double duty: an unknown key that must not survive stage-2
parsing, exercised directly in the stripping test) documenting its
provenance and the open question.

The `@provisional` marker is in the schema file's own module docstring
(`packages/schemas/src/webhooks/chatwoot.ts`, top of file) — not a
easy-to-miss adjacent comment. It states plainly that two things are
unverified: the payload shape itself, and which field (if any) carries
Meta's `wa_phone_number_id`. A second, narrower `@provisional` marker sits
directly on `extractResolutionKey`'s own docstring, naming the current best
guess (`inbox.phone_number`) and design D-6's stated fallback
(`account.id` / `brokers.chatwoot_account_id`) if that guess is wrong.

## What was written

- `packages/schemas/test/fixtures/chatwoot-message-created.json` — the
  provisional fixture (4.2).
- `packages/schemas/src/webhooks/chatwoot.ts` — two-stage parse (4.6):
  - `chatwootWebhookEnvelopeSchema` (stage 1): `z.object({ event, message_type })`,
    non-strict, cheap. `isIgnorableChatwootEvent(envelope)` lets a caller
    decide to discard anything that is not `message_created` /
    `message_type: "incoming"` before ever touching stage 2.
  - `chatwootMessageCreatedPayloadSchema` (stage 2): the full modeled shape.
    No `.passthrough()` anywhere — Zod's default (strip unknown keys) is
    relied on, per design D-6 and spec "Raw Payload Is Not Retained
    Verbatim" / P2.
  - `extractResolutionKey(payload): string` — reads only
    `payload.inbox.phone_number`; this is the single point of contact with
    that field name in the entire module.
- `packages/schemas/src/index.ts` — re-exports `./webhooks/chatwoot.js`,
  docstring updated to name it as the first webhook/API contract schema
  (the prior claim "Webhook/API contract schemas land in later changes" was
  now false and was corrected, mirroring the Phase 2 precedent of
  correcting stale docstrings rather than leaving them).
- `packages/schemas/test/webhooks/chatwoot.test.ts` — stage 1 and stage 2
  behavior tests (12 tests).
- `packages/schemas/test/webhooks/chatwoot-resolution-key-isolation.test.ts`
  — the isolation test required by 4.7 (3 tests).

## RED states confirmed (strict TDD, per the task brief)

- **4.3-4.5 (envelope, stripping, malformed-payload rejection)**: RED
  confirmed together as one batch — `pnpm --filter @dirus/schemas exec
  vitest run test/webhooks/chatwoot.test.ts` was run before
  `src/webhooks/chatwoot.ts` existed and failed for the right reason
  (`Failed to load url ../../src/webhooks/chatwoot.js ... Does the file
  exist?`), not a wrong-reason failure (e.g. a typo). Confirmed genuinely
  RED before writing the implementation.
- **4.7 (`extractResolutionKey` isolation)**: written and confirmed as its
  own distinct RED, separate from 4.6's GREEN, per the task's phrasing ("RED
  then GREEN" as its own numbered task rather than folded into 4.6).
  `extractResolutionKey` was temporarily removed from `chatwoot.ts` after
  4.6 landed, and `chatwoot-resolution-key-isolation.test.ts` was run:
  1 of 3 tests failed with `TypeError: extractResolutionKey is not a
  function` — RED for the right reason (missing export, not a resolution
  or import-path bug). The function was then restored (GREEN): all 3 tests
  passed.

## How the `extractResolutionKey` isolation was actually verified (task 4.7)

Two complementary checks, not one:

1. **Import-graph scan** (`chatwoot-resolution-key-isolation.test.ts`):
   recursively walks `apps/api/src/routes/webhooks` and
   `apps/api/src/middleware`, and for every `.ts` file, regex-matches any
   `import { ... } from "@dirus/schemas"` (or a relative import resolving to
   `webhooks/chatwoot(.js)`) and asserts every named import is in an
   exhaustive allowlist (`chatwootWebhookEnvelopeSchema`,
   `isIgnorableChatwootEvent`, `chatwootMessageCreatedPayloadSchema`,
   `extractResolutionKey`). Neither directory exists yet — verified directly
   (`ls apps/api/src` shows only `index.ts`) and asserted explicitly in a
   dedicated test (`expect(anyExists).toBe(false)`) so that fact is visible
   in test output rather than the scan silently finding zero files for an
   unrelated reason. The scan is written to hold once Phase 3/5 create those
   directories.

   **Mutation-verified that the scan is real enforcement, not a no-op given
   the current empty-directory state**: `mkdir -p
   apps/api/src/routes/webhooks` and a probe file
   `_mutation-probe.ts` importing a disallowed name
   (`someOtherLeakedInternal`) from `@dirus/schemas` were created; the scan
   test failed as expected (`imports "someOtherLeakedInternal" directly from
   the Chatwoot module`). The probe file and directory were then removed and
   the suite re-confirmed green (15/15 in `packages/schemas`). This is the
   same mutation-testing convention established in `extraction-schemas`,
   applied here to a structural/import-graph assertion rather than a schema
   assertion.
2. **Contract-shape test**: `extractResolutionKey` always returns a plain
   `string`, with nothing about the call signature or return value exposing
   which field backs it — asserted against the fixture in the same test
   file.

## Two-stage parse verification (not decoration)

- Stage 1 cheap-discard: tested that a non-`message_created` event, and a
  `message_created` event with `message_type !== "incoming"`, are both
  identified as ignorable via `isIgnorableChatwootEvent` from the envelope
  parse alone — no stage-2 schema is invoked in that path.
- Stage 2 stripping: tested twice — once against the fixture's own
  `_provisional` marker key, once against synthetic extra fields
  (`private_note_id`, `csat_survey_response`) spread onto the fixture. Both
  confirm the parsed result does not carry the extra key.  An initial
  source-text regex check for the literal absence of `.passthrough()` was
  attempted and discarded: the regex matched the module docstring's own
  prose (which mentions `.passthrough()` while explaining it is forbidden),
  a false positive from checking comments rather than behavior. The
  behavioral stripping tests are the correct and sufficient proof — they
  could not pass if `.passthrough()` were actually used.
- Stage 2 malformed-payload rejection: tested for a payload missing
  `sender` and one with an empty `conversation` object (missing `id`).

## Task 4.8 — explicitly not attempted

Left unchecked in `tasks.md`, per the task brief. It only fires if/when a
real Chatwoot payload is captured and shown to lack `wa_phone_number_id`.
No such payload exists in this environment; attempting it now would mean
guessing at a resolution to O4 rather than confirming it. Not scheduled.

## Verification actually run (all in this environment, offline by construction)

- `pnpm --filter @dirus/schemas exec vitest run test/webhooks/chatwoot.test.ts`
  — RED then GREEN as described above; final state 12/12 passing.
- `pnpm --filter @dirus/schemas exec vitest run
  test/webhooks/chatwoot-resolution-key-isolation.test.ts` — RED then GREEN
  as described above, plus the mutation-verification run; final state 3/3
  passing.
- `pnpm --filter @dirus/schemas test` (full package suite): **57/57 passing**
  across 6 files (`primitives`, `caratula`, `cedula`, `tarjeta-propiedad`
  unchanged from `extraction-schemas`, plus the two new Phase 4 files).
- `pnpm -r run typecheck`: clean across all 8 workspace projects with a
  `typecheck` script (including `apps/api`, `packages/db`).
- `pnpm run lint` (repo-wide eslint): one real defect found and fixed — an
  unused destructured binding (`_sender`) in a test's object-rest-omit
  pattern tripped `@typescript-eslint/no-unused-vars`; rewritten as a
  `delete` on a spread copy instead. Clean after the fix.
- `pnpm run lint:deps` (dependency-cruiser): clean — "no dependency
  violations found (85 modules, 187 dependencies cruised)".
- `packages/schemas/package.json` confirmed unchanged: `dependencies: {
  zod }`, `devDependencies: {}` — **zero `workspace:*` deps**, satisfying
  4.9's second half and the standing dependency rule.

## Deviations from a literal reading of `tasks.md`

- The isolation check for 4.7 was implemented as an import-name allowlist
  scan rather than a literal string search for the field path
  (`inbox.phone_number`) across the consumer directories. This is a
  stronger guarantee: it holds regardless of what the resolution-key field
  is ever renamed to, as long as callers only ever import
  `extractResolutionKey` (never reach into the schema's parsed shape
  directly) — which is the actual isolation property design D-6 asks for.
- `extractResolutionKey`'s backing field, `inbox.phone_number`, was made
  **required** (not `.optional()`) in `chatwootInboxSchema`, so that a
  payload missing it fails stage-2 parsing loudly (400) rather than
  `extractResolutionKey` silently returning an empty string that would then
  miss-resolve to no tenant. This was not explicitly specified in
  `tasks.md` but follows directly from `extractResolutionKey`'s declared
  return type (`string`, never `string | undefined`) in design D-6.

## Not done, correctly out of scope for this batch

- Task 4.8 (see above — deliberately not attempted, reason stated).
- Everything in Phase 5-6: no `apps/api/src/routes/webhooks`, no
  `apps/api/src/middleware`, no ingest pipeline, no persistence, no live
  concurrency tests. This batch touched only `packages/schemas`.

## Phase 5: Ingest pipeline (design D-2, D-3, D-4, D-5, D-6)

All 22 tasks (5.1-5.22) implemented and marked `[x]`.

### Files created

| File | Purpose |
|---|---|
| `apps/api/src/middleware/webhook-auth.ts` | D-4 bearer-credential auth: header or path-segment token, `crypto.timingSafeEqual` after a length check, reads and stores raw body |
| `apps/api/src/middleware/tenant-resolver.ts` | D-1/D-5: resolves `c.var.brokerId` from `c.var.resolutionKey` via an injected `resolveBrokerId`; logs only `wa_phone_number_id` on a miss (P4) |
| `apps/api/src/routes/webhooks/chatwoot.ts` | Wires auth -> parse (stage1/stage2, D-6) -> tenant resolve -> `ingest` -> post-commit echo |
| `apps/api/src/services/ingest-message.ts` | D-2/D-3 four-statement transaction inside one `withBrokerContext` call; "no HTTP types cross this line" (D-5) |
| `packages/integrations/src/chatwoot.ts` | Minimal typed client: `FIXED_ACKNOWLEDGEMENT_REPLY` (P1) + `sendReply` via `fetch` |
| `apps/api/test/middleware/webhook-auth.test.ts`, `test/middleware/tenant-resolver.test.ts`, `test/routes/webhooks/chatwoot.test.ts`, `test/services/ingest-message.no-media-fetch.test.ts`, `test/services/ingest-message.live.test.ts`, `packages/integrations/test/chatwoot.test.ts` | Offline unit/route tests + one live (skipped locally) suite |

### Files modified

- `apps/api/src/app.ts` — `CreateAppOptions` extended with `resolveBrokerId`, `webhookToken`, `sendEcho`; `Ingest`/`SendEcho` retyped against `ChatwootMessageCreatedPayload`; `AppVariables` now a single app-wide context-variable map merging the health/ingest variable with the webhook route's auth/tenant/payload variables (Hono types context variables per app instance, not per route); registers the Chatwoot webhook route.
- `apps/api/src/index.ts` — real wiring: `ingestMessage` (services/ingest-message.ts), `resolveBrokerIdByWaPhoneNumberId` (`@dirus/db`), a real `createChatwootClient` for `sendEcho`, `env.CHATWOOT_WEBHOOK_TOKEN`. Replaces Phase 3's placeholder.
- `apps/api/test/app.test.ts`, `apps/api/test/routes/health.test.ts` — updated to pass the three new required `createApp` options (fakes).
- `apps/api/package.json` — added `drizzle-orm` (runtime dep, for the transaction query builder) and `pg`/`@types/pg` (devDependency, only reachable from the live test's `skipIf` branch).
- `packages/schemas/package.json`, `packages/integrations/package.json` — added `"exports": { ".": "./src/index.ts" }`. Neither had one; `moduleResolution: NodeNext` cannot resolve a bare `@dirus/schemas`/`@dirus/integrations` specifier without it. `packages/db` already had this; the omission on the other two packages was latent until Phase 5 became the first code to import them by package name rather than by relative path.
- `packages/integrations/src/index.ts` — re-exports `./chatwoot.js`.
- `packages/schemas/test/webhooks/chatwoot-resolution-key-isolation.test.ts` — flipped the trip-wire assertion (see below).

### D-2's statement order — how it was verified

`services/ingest-message.ts`'s `runIngestTransaction` implements the four
statements in the exact textual order design D-2 requires: contacts upsert
(`onConflictDoUpdate`, target `[brokerId, phone]`, `set: { phone:
sql\`excluded.phone\` }`) first — never `onConflictDoNothing` — then the
conversation `SELECT`, then the conditional conversation `INSERT`, then the
messages insert (`onConflictDoNothing`, target `waMessageId`). All four run
against the same `tx: TenantDb` handed to `withBrokerContext`'s callback, so
they are one transaction by construction (there is no way to call a second
`db.transaction`/`withBrokerContext` from inside the callback without
tripping `tenant.ts`'s reentrancy guard).

**Verification actually possible in this environment**: source-level
confirmation that the four Drizzle calls appear in that order, that the
contacts upsert uses `onConflictDoUpdate` (never `onConflictDoNothing`), and
a full `pnpm -r run typecheck` pass (Drizzle's `.onConflictDoUpdate`/
`.onConflictDoNothing` types would reject a target that doesn't match a real
unique constraint on the table). **What was NOT possible**: executing this
against a real Postgres to observe the row lock / blocking behavior D-2
depends on — no Postgres, Docker, or Podman is reachable on this machine.
`ingest-message.live.test.ts`'s sequential tests (5.10/5.11/5.13) exercise
this code path against a real throwaway-schema fixture, but the entire suite
is `describe.skipIf(!LIVE_TEST_DATABASE_URL)` and **reports 4 tests
skipped, not passing**, in this run. This is the single biggest gap in this
batch's verification — see "Blocked / unverified" below.

### D-3's dedup/echo-suppression behavior — how it was verified

Two independent things were checked:

1. **The dedup signal itself** (`{ deduplicated: boolean }`): `messages`
   insert uses `onConflictDoNothing({ target: schema.messages.waMessageId
   }).returning(...)`; `runIngestTransaction` returns `{ deduplicated:
   insertedMessages.length === 0 }`. On the losing side, no `throw` occurs —
   the function returns normally, so the transaction commits (steps 1-3
   already ran and are idempotent). This matches D-3's "Losing side"
   paragraph. Live-verified in `ingest-message.live.test.ts`'s third `it`
   (sequential duplicate, same `wa_message_id`, second call reports
   `{deduplicated: true}`, exactly one `messages` row) — **skipped in this
   run**, unverified locally.
2. **Echo suppression** (route-level, does NOT need a database):
   `apps/api/test/routes/webhooks/chatwoot.test.ts` covers this fully
   offline with a fake `ingest`: (a) `ingest` resolves `{deduplicated:
   true}` -> `sendEcho` is asserted never called; (b) `ingest` throws ->
   `sendEcho` is asserted never called, response is 5xx; (c) `ingest`
   resolves `{deduplicated: false}` -> `sendEcho` IS called exactly once.
   This suite genuinely RAN (not skipped) and is the load-bearing proof
   that the route never echoes on the failure or dedup-loss path — this is
   the piece task 5.20/5.21 actually cared about ("no echo call reaches the
   Chatwoot client"), and it does not require the live database at all
   since it is asserting on the route's control flow, not on Postgres
   behavior.

### P4's log-line constraint — how it was verified

`tenant-resolver.test.ts`'s third test spies on `console.error`, triggers a
resolution miss, and asserts the logged text (a) contains the
`wa_phone_number_id` and (b) does NOT match
`/message body|sender|content|full_?name/i`. `tenant-resolver.ts` calls
`console.error("tenant_resolution_miss", { wa_phone_number_id: key })` —
one structured argument built from exactly one field, not string
concatenation with anything else from the request — which makes it
mechanically impossible for this call site to leak other payload fields,
not just conventionally unlikely to.

### Chatwoot resolution-key isolation trip-wire — flipped and verified

`packages/schemas/test/webhooks/chatwoot-resolution-key-isolation.test.ts`'s
first test previously asserted `apps/api/src/routes/webhooks` and
`apps/api/src/middleware` do NOT exist. Both now exist (this phase created
them), so the assertion was flipped to `expect(anyExists).toBe(true)`, per
the test's own comment ("Flip this expectation once Phase 3/5 create these
directories — at that point the scan below starts doing real enforcement
work").

**Verified the enforcement is real, not just re-enabled by name**: created
`apps/api/src/routes/webhooks/_mutation-probe.ts` importing
`chatwootWebhookEnvelopeSchema as leakedInternal` from `@dirus/schemas` (a
disallowed alias — not in `ALLOWED_CHATWOOT_IMPORTS`). Re-ran the isolation
suite: the second test (the import-allowlist scan) failed with `imports
"chatwootWebhookEnvelopeSchema as leakedInternal" directly from the
Chatwoot module`, confirming the scan now does real work against the real
directories rather than passing vacuously because both directories are
still empty. Removed the probe file; suite re-confirmed green (3/3). This
is the same mutation-testing convention established in `extraction-schemas`.

Separately confirmed the actual production files comply: `chatwoot.ts` (the
route) imports exactly `chatwootMessageCreatedPayloadSchema`,
`chatwootWebhookEnvelopeSchema`, `extractResolutionKey`,
`isIgnorableChatwootEvent` — the full allowlist, nothing else. Neither
`webhook-auth.ts` nor `tenant-resolver.ts` imports `@dirus/schemas` at all.

### Task 5.16 — mutation-testing convention, and what it actually covered

`services/ingest-message.ts` never attempts a media fetch by construction:
`media_r2_key`/`mediaR2Key` is never present in the messages insert's
`values(...)` object, for any `content_type`. A literal RED (a failing test
against not-yet-correct behavior) was not attainable for this property
without first breaking the implementation, exactly as task 5.16
anticipated. Two mutation-test runs were performed, both against files that
run **offline** (no database needed), which is stronger evidence for this
specific environment than deferring entirely to the live suite:

1. `apps/api/test/services/ingest-message.no-media-fetch.test.ts` — asserts
   `services/ingest-message.ts`'s source text contains no `fetch(`,
   `axios`, or `http.request(` call, and never sets `mediaR2Key:` in any
   insert. **Mutation run**: inserted `async function
   unusedMediaFetchProbe(){ await fetch("http://example.com/media"); }`
   into the file; the fetch-call assertion failed as expected (regex
   matched); removed the probe function; re-ran, green. This proves the
   regex is not vacuously true (an earlier draft using `/\bfetch\s*\(/`
   with `\s*` instead of a strict `fetch(` was itself a false positive
   against this file's own doc-comment prose — "a media fetch (spec..." —
   caught during this same verification pass and corrected before the
   mutation run).
2. `ingest-message.live.test.ts`'s fourth `it` (media message, spies on
   global `fetch`, asserts zero calls, asserts `media_r2_key IS NULL` after
   a real insert) is the full behavioral proof design/tasks.md actually
   ask for — but this test is inside the `describe.skipIf(!liveUrl)` block
   and **did not run** in this environment (reported skipped, not green).

### Blocked / unverified in this environment (report plainly, not silently)

No Postgres, Docker, or Podman is reachable here — verified directly (no
`docker`/`podman` binary, no local Postgres listening). Every task in this
phase that requires a real transaction is consequently **unverified
locally** and must be confirmed in CI:

- Tasks 5.10, 5.11, 5.13 (`ingest-message.live.test.ts`'s first three
  `it`s: new-sender row creation, repeat-sender reuse, sequential dedup) —
  4 tests total in that file, **all reported SKIPPED**, not passing.
- Task 5.15's live half (media persistence + no-fetch, live-verified) — the
  4th test in the same file, also skipped. The offline structural
  counterpart (`ingest-message.no-media-fetch.test.ts`) DID run and pass,
  and was itself mutation-verified (see above), but that is source-text
  evidence, not a proof that Postgres actually persists the row correctly.
- The row-lock/serialization claim underlying D-2 (that `DO UPDATE`
  actually blocks a second transaction at step 1) cannot be observed
  without concurrent access to a real Postgres server at all — this
  phase's live test is explicitly sequential only (task 5.10's own
  instruction: "not as an offline unit test... SEQUENTIAL only"); the
  concurrent proof is Phase 6's job, not this phase's, and is equally
  blocked in this environment for the same reason.

`ingest-message.live.test.ts` is gated correctly
(`describe.skipIf(!liveUrl)` on `LIVE_TEST_DATABASE_URL`, the same
convention `live-rls-verification.test.ts`/`tenant-live-round-trip.test.ts`
use) and its own file header states this blockage explicitly, mirroring
`tenant-live-round-trip.test.ts`'s precedent for the same situation.

### TDD Cycle Evidence

| Task(s) | RED confirmed? | GREEN | REFACTOR / notes |
|---|---|---|---|
| 5.2/5.3/5.4 (webhook-auth) | Yes — module missing, `Failed to load url ../../src/middleware/webhook-auth.js` | Yes, 5/5 passing | Test's own bug found+fixed (empty-body `res.json()` call) before final GREEN |
| 5.5/5.6/5.7 (tenant-resolver) | Yes — module missing | Yes, 3/3 passing | — |
| 5.8/5.9 (route wiring) | Yes — module missing (`./routes/webhooks/chatwoot.js` unresolved from `app.ts`) | Yes, after fixing an `app.post([...], ...)` array-of-paths routing bug (all handlers 404'd) by registering two separate `app.post(path, ...)` calls sharing the same handler functions | — |
| 5.20/5.21 (echo suppression) | Yes — same route-module-missing RED covers these assertions | Yes, all 3 relevant `it`s pass (dedup-suppresses-echo, failure-suppresses-echo, success-sends-echo) | — |
| 5.10/5.11/5.12/5.13/5.14 (ingest-message.ts core) | **No** — implementation was written before the live test file, and the live suite cannot execute in this environment regardless (no Postgres), so no RED/GREEN cycle was actually observed for this file's behavior. Structural-only confirmation (statement order, `onConflictDoUpdate`/`onConflictDoNothing` targets, typecheck) was performed instead. | Unverified locally | **Deviation from strict TDD, disclosed rather than silently skipped.** Must be confirmed in CI. |
| 5.15/5.16 (media, no-fetch) | Partial — the offline structural test was also written after the implementation, but its assertion was then mutation-verified twice (once catching my own regex bug, once catching a deliberately reintroduced `fetch` call) | Yes, offline test 2/2 passing | Live behavioral half unverified locally (see above) |
| 5.17/5.18/5.19 (fixed reply) | Partial — `chatwoot.ts` (the client) was written before `chatwoot.test.ts`; task 5.17 explicitly says the copy string itself needs no RED. The discriminating test (5.18) was written after the constant existed, but one of its own table cases (customer literally sends the fixed copy back) produced a genuine failure on first run, caught, and removed as testing the wrong invariant (coincidental equality is not "derived from" the customer's text) | Yes, 7/7 passing | Disclosed as a process deviation, not a design one |
| 5.22 (index.ts wiring) | N/A (bootstrap wiring, not independently testable without a live server) | `pnpm -r run typecheck` passes with the real imports wired in | — |

**Honest summary**: every HTTP-facing/control-flow piece of this pipeline
(auth, tenant resolution, envelope/payload parsing, echo suppression) went
through a genuine RED-before-GREEN cycle with a confirmed-real failure
reason. The database-transaction core (`ingest-message.ts`'s actual D-2/D-3
SQL behavior) did not — the environment made a literal RED impossible to
observe (no Postgres reachable at all, not even to see a "table does not
exist" failure), so implementation, source-level order verification, and a
correctly-skipped live suite were the best available substitute. This is
flagged here rather than reported as complete.

### Deviations from a literal reading of `tasks.md`

- Task 5.9's dash-list ("auth middleware -> tenant resolver -> stage-1
  envelope parse -> ...") reads as tenant resolution preceding payload
  parsing. This is not logically possible: `extractResolutionKey` (design
  D-6) operates on the STAGE-2 parsed payload, so a `wa_phone_number_id`
  cannot be known before that parse completes. Implemented per design.md's
  Technical Approach instead, which states the order unambiguously in
  prose: "authenticate → parse → resolve tenant → transaction → commit →
  echo." Route order actually implemented: auth -> stage-1 parse (ignore
  check) -> stage-2 parse (400 check) -> extractResolutionKey -> tenant
  resolve -> ingest -> echo.
- `apps/api/src/app.ts`'s `AppVariables` type became a single merged map
  (health/ingest + webhook-auth + tenant-resolver + parsed payload) rather
  than each route/middleware carrying its own narrower context type. Hono
  types context variables per `Hono` instance, not per route, so this was
  required for `registerChatwootWebhookRoute`'s handlers (which read
  `c.var.rawBody`/`resolutionKey`/`brokerId`/`payload`) to typecheck
  against the same `app` the health route is also registered on. Not
  called out explicitly in design/tasks, but the only structurally
  possible shape given Hono's typing model.
- `packages/schemas/package.json` and `packages/integrations/package.json`
  gained an `"exports"` field neither had before. Not a Phase 5 task item,
  but required for `moduleResolution: NodeNext` to resolve `@dirus/schemas`
  / `@dirus/integrations` as bare package specifiers — `packages/db`
  already had this; the gap was latent because no prior phase imported
  either package by name (only by relative path within `packages/schemas`
  itself, or not at all for `packages/integrations`).
- `apps/api/package.json` gained `drizzle-orm` as a direct runtime
  dependency (needed by `services/ingest-message.ts`'s query builder calls
  — `and`, `desc`, `eq`, `sql` — which are not re-exported through
  `@dirus/db`'s barrel) and `pg`/`@types/pg` as devDependencies (needed
  only by `ingest-message.live.test.ts`'s throwaway-schema fixture setup,
  gated behind `skipIf`).

### Verification actually run in this environment

- `pnpm --filter @dirus/integrations test` — 7/7 passing.
- `pnpm --filter @dirus/api test` — **27/27 passing, 4 skipped** (the live
  suite; reported skipped, not claimed green).
- `pnpm --filter @dirus/schemas test` — 57/57 passing (all prior phases'
  tests plus the flipped isolation test), full package.
- `pnpm -r run test` — full monorepo: all files pass or correctly skip; no
  unexpected failures. `packages/db`: 97 passing, 31 skipped (pre-existing
  live suites, unrelated to this phase, same "no Postgres reachable"
  reason).
- `pnpm -r run typecheck` — clean across all 8 workspace projects with a
  `typecheck` script.
- `pnpm run lint` (repo-wide eslint) — clean, no findings.
- `pnpm run lint:deps` (dependency-cruiser) — clean: "no dependency
  violations found (107 modules, 239 dependencies cruised)".

### Not done, correctly out of scope for this batch

- Phase 6 in full: no concurrent-delivery test, no concurrent-first-contact
  test, no isolation fixture extended to `messages`/`conversations`/
  `contacts`, no ROADMAP correction (task 6.9). Explicitly excluded from
  this batch's scope per the task brief ("Phase 6's live concurrency tests
  are NOT this phase").
- Task 4.8 remains unattempted (Phase 4, unchanged — O4 still unconfirmed).
- The live half of tasks 5.10/5.11/5.13/5.15 (see "Blocked / unverified"
  above) — implemented and gated correctly, but not executed here. Must
  run in CI before this phase can be considered empirically proven, not
  just internally consistent.
