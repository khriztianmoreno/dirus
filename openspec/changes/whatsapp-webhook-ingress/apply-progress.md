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
