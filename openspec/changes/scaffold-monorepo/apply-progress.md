# Apply Progress: Scaffold the DIRUS monorepo and persistence foundation

**Mode**: Strict TDD throughout. Phase 1: RED/GREEN applied to tasks 1.4/1.5
and the schemas zero-workspace-deps assertion added under 1.8; tasks 1.1-1.3
and 1.6-1.8 are structural scaffolding — package.json/tsconfig/typed-entrypoint
files with no branching logic — verified via `pnpm -r typecheck` and
`pnpm -r test` per task 1.9 rather than synthetic unit tests. Phase 2: full
RED/GREEN/REFACTOR cycle on every task (2.1-2.9); a RED-verified regression
test (2.2) plus one extra live-round-trip test (2.10, added beyond the literal
task list per design.md D-A) are blocked/skipped pending a real Postgres
connection. Phase 3: RED/GREEN on every task (3.1-3.5); all schema tests are
structural (`getTableConfig()` introspection of the Drizzle table
definitions), not live-database tests — no migration has been generated yet
(Phase 4) and no live Postgres connection is available in this environment
(same constraint as Phase 2's 2.10). Phase 4: RED/GREEN on every task
(4.1-4.8), all static-SQL RED cycles verified for real (not assumed) —
including one genuine bug caught by RED itself (an `eq()`-based partial
index rendering an unbound `$1` placeholder). Unlike Phases 2/3, a real
Postgres connection (`pgvector/pgvector:pg17` via Docker/OrbStack) became
available in this batch; all 6 of the spec's load-bearing RLS guarantees
(FORCE-vs-owner, unset/`''` context, cross-tenant read/update/delete/insert,
app-role privilege level) were verified against it, both manually and via
a new committed, `LIVE_TEST_DATABASE_URL`-gated regression test. Phase 2's
previously-skipped live round-trip test (2.10) was also run for the first
time in this environment and passed.

## Chain / Branch Topology

- Chain strategy: `feature-branch-chain` (user-selected)
- Tracker branch: `feat/scaffold-monorepo` → points at baseline commit
  `0ab46f3` (pre-existing planning artifacts only; untouched by this batch)
- PR 1 / Unit 1 branch: `feat/scaffold-monorepo-workspace-foundation`
  (base = tracker branch) — **accepted by the user at `size:exception`**
  (479 vs 400-line budget, ~20% over; kept as one PR because it is the
  smallest unit that fully satisfies the `workspace-foundation` spec)
- PR 2 / Unit 2 branch: `feat/scaffold-monorepo-db-driver-tenant-guards`
  (base = `feat/scaffold-monorepo-workspace-foundation`)
- PR 3 / Phase 3 branch: `feat/scaffold-monorepo-schema-tables`
  (base = `feat/scaffold-monorepo-db-driver-tenant-guards`)
- PR 4 / CI branch: `feat/scaffold-monorepo-ci-workflow`
  (base = `feat/scaffold-monorepo-schema-tables`)
- PR 5 / Phase 4 branch: `feat/scaffold-monorepo-migrations`
  (base = `feat/scaffold-monorepo-ci-workflow`)
- Current branch: `feat/scaffold-monorepo-migrations`
- No push, no PR opened — local commits only, per instructions.

## Phase 1: Workspace Foundation — COMPLETE (9/9 tasks)

- [x] 1.1 `pnpm-workspace.yaml` (apps/*, packages/*) + root `package.json`
      with `-r`-based `typecheck`/`test` scripts.
- [x] 1.2 `.gitignore` already present (pre-existing); added `.env.example`
      documenting `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `ALLOW_UNPOOLED_RUNTIME`.
- [x] 1.3 `packages/config`: `tsconfig.base.json`, `eslint.config.js` (flat,
      exported `base` array), `vitest.config.ts` (exported `base`).
- [x] 1.4 RED: `packages/config/test/dependency-rule.test.ts` written first,
      referencing `.dependency-cruiser.cjs` which did not yet exist —
      confirmed failing (`Does the file exist?`) before any production code.
- [x] 1.5 GREEN: `.dependency-cruiser.cjs` with `no-packages-to-apps` and
      `no-app-to-app` rules; test wired to `cruise()` programmatically
      against fixture workspaces; root `pnpm lint:deps` added.
- [x] 1.6 `apps/{api,dashboard,jobs}`: package.json + tsconfig (extends
      `@dirus/config/tsconfig.base.json`) + minimal typed `src/index.ts`.
      No Hono/Vite/Trigger.dev wiring.
- [x] 1.7 `packages/{agents,integrations}`: same shell pattern as apps.
- [x] 1.8 `packages/schemas`: package.json with zero deps/devDeps (no
      `@dirus/config` workspace dependency — tsconfig extends it via a
      **relative path** instead, so no `workspace:*` entry is needed);
      RED/GREEN test added asserting the real `package.json` has no
      `workspace:*` values.
- [x] 1.9 Verified: `rm -rf node_modules && pnpm install` (from lockfile,
      clean) succeeds; `pnpm -r run typecheck` (7/7 packages) succeeds;
      `pnpm -r run test` (7/7 packages) succeeds; `pnpm lint:deps` reports
      zero violations against the real repo (19 modules, 9 deps cruised).

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.4/1.5 | `packages/config/test/dependency-rule.test.ts` (`flags a package importing from an app`, `flags one app importing from another app`) | Unit (dependency-cruiser invoked programmatically) | N/A (new file) | ✅ Written — failed with `Does the file exist?` before `.dependency-cruiser.cjs` existed | ✅ Passed after `.dependency-cruiser.cjs` created | ✅ 2 cases (packages→apps rule, app→app rule) + compliant-workspace case | ➖ None needed — rules are declarative config, no logic to simplify |
| 1.5 | `packages/config/test/dependency-rule.test.ts` (`passes with zero violations for a compliant workspace`) | Unit | N/A (new) | ✅ Written alongside the two violation cases | ✅ Passed | ➖ Single (positive-path complement to the two violation cases above) | ➖ None needed |
| 1.8 | `packages/config/test/dependency-rule.test.ts` (`packages/schemas declares zero workspace dependencies`) | Unit (manifest read) | N/A (new) | ✅ Written first, referencing `packages/schemas/package.json` before that file existed — failed with `ENOENT` | ✅ Passed after `packages/schemas/package.json` created with empty `dependencies`/`devDependencies` | ➖ Single — one manifest, boolean fact, no branching to triangulate further | ➖ None needed |
| 1.1, 1.2, 1.3, 1.6, 1.7, 1.8 (structural) | N/A — no unit test written | Structural (package.json/tsconfig/typed-entrypoint creation, zero logic/branching) | N/A | Triangulation skipped: purely structural, no branching, single possible output per file | Verified via `pnpm -r typecheck` (7/7 pass) and `pnpm -r test` (7/7 pass, `--passWithNoTests` for shells with no logic yet) | ➖ N/A | ➖ N/A |

### Test Summary

- **Total tests written**: 4 (all in `packages/config/test/dependency-rule.test.ts`)
- **Total tests passing**: 4/4
- **Layers used**: Unit (4)
- **Approval tests** (refactoring): None — no refactoring tasks in Phase 1 (all new files)
- **Pure functions created**: 0 production functions (Phase 1 is scaffolding/config only; `withBrokerContext`/`assertUuid` etc. are Phase 2)

## Files Changed (Phase 1)

| File | Action | What Was Done |
|------|--------|----------------|
| `pnpm-workspace.yaml` | Created | Workspace globs `apps/*`, `packages/*` |
| `package.json` (root) | Created | `-r`-based `typecheck`/`test` scripts, `lint`, `lint:deps`; shared devDependencies (typescript, vitest, dependency-cruiser, eslint, typescript-eslint, @eslint/js, @types/node) |
| `.env.example` | Created | Documents `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `ALLOW_UNPOOLED_RUNTIME` |
| `eslint.config.js` (root) | Created | Imports and extends the shared flat config from `packages/config` |
| `packages/config/package.json` | Created | `@dirus/config`, exports base tsconfig/eslint/vitest configs |
| `packages/config/tsconfig.base.json` | Created | Strict base compiler options (ES2022, NodeNext) |
| `packages/config/tsconfig.json` | Created | Self-typecheck config for the config package |
| `packages/config/eslint.config.js` | Created | Shared flat ESLint config (`base` export) |
| `packages/config/vitest.config.ts` | Created | Shared Vitest base config (`base` export) |
| `packages/config/src/index.ts` | Created | Typed entrypoint placeholder |
| `packages/config/test/dependency-rule.test.ts` | Created | 4 tests: 2 violation cases, 1 compliant case, 1 schemas-manifest case |
| `.dependency-cruiser.cjs` | Created | `no-packages-to-apps`, `no-app-to-app` rules |
| `apps/api/{package.json,tsconfig.json,src/index.ts}` | Created | Empty typed shell |
| `apps/dashboard/{package.json,tsconfig.json,src/index.ts}` | Created | Empty typed shell |
| `apps/jobs/{package.json,tsconfig.json,src/index.ts}` | Created | Empty typed shell |
| `packages/agents/{package.json,tsconfig.json,src/index.ts}` | Created | Typed shell |
| `packages/integrations/{package.json,tsconfig.json,src/index.ts}` | Created | Typed shell |
| `packages/schemas/{package.json,tsconfig.json,src/index.ts}` | Created | Typed shell, zero workspace deps (relative-path tsconfig extends) |

## Verification Output (task 1.9)

```
$ rm -rf node_modules && pnpm install
Lockfile is up to date, resolution step is skipped
Done in 931ms using pnpm v10.34.5

$ pnpm -r run typecheck
Scope: 7 of 8 workspace projects
... all 7 packages: Done (zero errors)

$ pnpm -r run test
Scope: 7 of 8 workspace projects
packages/config test: ✓ test/dependency-rule.test.ts (4 tests) — Test Files 1 passed (1), Tests 4 passed (4)
apps/api, apps/dashboard, apps/jobs, packages/agents, packages/integrations, packages/schemas:
  No test files found, exiting with code 0 (--passWithNoTests)

$ pnpm run lint:deps
✔ no dependency violations found (19 modules, 9 dependencies cruised)

$ pnpm run lint
(no output — zero ESLint problems)
```

## Deviations from Design

- None in mechanism. One scope note: `packages/db` is out of scope for
  Phase 1 (`pnpm -r typecheck`/`pnpm -r test` report "7 of 8 workspace
  projects" because `packages/db` does not exist yet — created in Phase 2).
  This matches `tasks.md` phase boundaries exactly.
- `eslint.config.js` at the repo root and the root `lint` script are an
  addition beyond the literal task wording (tasks only required
  `packages/config` to *expose* a flat ESLint config). Added so the shared
  config is actually wired and runnable, not just present; low risk,
  zero new dependencies beyond what task 1.3 already required.

## Issues Found

- `dependency-cruiser`'s programmatic `cruise()` API requires
  `{ ruleSet, validate: true }` — passing the rule set as the top-level
  options object (undocumented-looking pitfall) silently produces zero
  violations with all `valid: true`. Confirmed via a throwaway script
  before writing the RED test, so the RED test failed for the right
  reason (missing config), not an API misuse bug.
- pnpm's `pnpm run` PATH resolution walks up through workspace-root
  `node_modules/.bin`, so shared devDependencies (typescript, vitest,
  dependency-cruiser, eslint) declared once at the workspace root are
  usable from every sub-package script without per-package duplication.
  `packages/config` and `packages/schemas` are the two exceptions:
  `packages/config` needed its own `dependency-cruiser` devDependency
  because it `import`s the module directly in a test (module resolution,
  not a CLI bin, does not walk the tree the same way and needed the
  package listed as a direct dependency for pnpm's strict linking).

## Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`)
- Current work unit: Unit 1 — Workspace Foundation (fully satisfies the
  `workspace-foundation` spec; PR 1 of 3 per `tasks.md` Suggested Work Units)
- Boundary: starts from an empty repo (only pre-existing planning
  artifacts on the `feat/scaffold-monorepo` tracker branch) and ends with a
  fully installable, typecheckable, testable, lint-clean pnpm workspace
  with 8 packages and zero import-boundary violations. `packages/db`
  (Phase 2) is explicitly out of scope.
- Review budget: `git diff --stat` tracker..unit1 (excluding `pnpm-lock.yaml`)
  = **30 files changed, 479 insertions(+), 0 deletions(-)**. This exceeds
  the 400-line budget by ~20%. Flagged as a risk in the return summary —
  the slice was kept as one PR because it is the smallest unit that fully
  satisfies the `workspace-foundation` spec (all 4 requirements need the
  topology, the enforcement test+rule, and every package/app shell present
  simultaneously to be verifiable); further splitting would leave
  intermediate commits with a failing `pnpm -r test`/`pnpm lint:deps`.
  **User-accepted at `size:exception`.**

## Phase 2: DB Driver & Tenant Guards — COMPLETE (9/9 tasks + 1 added)

- [x] 2.1 `packages/db/package.json`: `pg` + `drizzle-orm` (dependencies),
      `drizzle-kit` + `tsx` + `@types/pg` (devDependencies), `@dirus/config`
      workspace devDependency. `exports` map restricted to `.` and
      `./schema` from the start (design.md D-C point 1).
- [x] 2.2 RED/GREEN: `test/dependency-guard.test.ts` asserts
      `@neondatabase/serverless` is absent from `dependencies`/
      `devDependencies` and that `pg` is present. RED verified by
      temporarily adding `@neondatabase/serverless` to the manifest via a
      throwaway script, confirming the test failed with the expected
      assertion message, then removing it and confirming GREEN (package.json
      already existed from 2.1, so this is a permanent regression guard
      rather than new-file-driven RED, same pattern as the Phase 1 schemas
      manifest check).
- [x] 2.3 RED: `test/client-env-guards.test.ts` — 7 cases covering both
      `src/internal/client.ts` (pooled) and `src/internal/admin.ts`
      (unpooled) guards. Confirmed failing with "Does the file exist?"
      before either file existed.
- [x] 2.4 GREEN: `src/internal/client.ts` (`readDatabaseUrl` +
      `assertPooledHost`, throws at import time) and `src/internal/admin.ts`
      (`readUnpooledUrl` + `assertUnpooledHost`, symmetric guard for
      `DATABASE_URL_UNPOOLED`, exports `unsafeAdminDb`). Also created
      `src/schema/index.ts` as an empty placeholder (`export {}`) — both
      client modules import `../schema/index.js` for `drizzle({ schema })`
      wiring; the real §7.1/§7.2 tables land in Phase 3.
- [x] 2.5 RED: `test/barrel-surface.test.ts` — asserts `package.json#exports`
      is exactly `{".", "./schema"}` (already true from 2.1, so this
      assertion started green) and that `src/index.ts` exports
      `withBrokerContext` but never `db`/`pool`/`unsafeAdminDb` (RED: file
      didn't exist yet).
- [x] 2.6 GREEN: `src/index.ts` barrel — exports `withBrokerContext`,
      `assertUuid`, `TenantDb` (type), and `schema` (namespace). Never
      imports from `./internal/client` or `./internal/admin`.
- [x] 2.7 RED: `test/tenant.test.ts` `assertUuid` describe block — 3 cases
      (malformed, empty string, well-formed). Confirmed failing
      ("Does the file exist?", `src/tenant.ts` didn't exist).
- [x] 2.8 RED: same file, `withBrokerContext` describe block — 2 cases:
      (a) wraps `fn` in `db.transaction`, calls `set_config('app.broker_id',
      $1, true)` before invoking `fn`, `true` rendered as a SQL literal (not
      a bound param) via `SQL.toQuery()`; (b) rejects a malformed `brokerId`
      **before** `db.transaction` is ever called (asserted via a spy that
      must never fire). `db` is mocked via `vi.doMock` on
      `./internal/client.js` so these are true unit tests, no network I/O.
- [x] 2.9 GREEN: `src/tenant.ts` — `UUID_RE`-based `assertUuid`; `TenantDb`
      type derived directly from `db.transaction`'s callback parameter type
      (`Parameters<Parameters<(typeof db)["transaction"]>[0]>[0]`, always in
      sync with Drizzle's own inference, no hand-rolled `PgTransaction`
      generics); `withBrokerContext` calls `assertUuid` first, then
      `db.transaction(...)`, then `tx.execute(sql`select set_config(...)`)`
      before invoking `fn`.
- [x] 2.10 (added — not in the literal task list, but design.md D-A states
      explicitly: *"A second test proves the round trip: set app.broker_id
      inside a transaction, read it back, commit, then assert it is unset on
      the next checkout of the same pool."* This is a distinct guarantee
      from 2.8, which only proves the SQL shape against a mock — it cannot
      prove Postgres actually discards the setting.) Added
      `test/tenant-live-round-trip.test.ts`: opens a `max: 1` pool (forces
      every checkout onto the same physical connection), sets
      `app.broker_id` inside an explicit `BEGIN`/`COMMIT`, reads it back
      inside the transaction (asserts it equals the broker id), commits,
      then queries `current_setting('app.broker_id', true)` again on a fresh
      checkout of the same pool and asserts it is unset (`''`/`NULL`).
      **BLOCKED/SKIPPED in this environment**: no live Postgres connection
      is reachable (sandboxed apply run; `.env` is not readable under this
      session's permission settings, and no `LIVE_TEST_DATABASE_URL` is set
      in the shell). Gated via `describe.skipIf(!liveUrl)` — reported as
      `↓ 1 skipped`, not claimed green, not weakened to run against a mock.
      **This must be run against a real Postgres connection (Neon or
      otherwise) before the change is considered verified.**

### TDD Cycle Evidence (Phase 2)

| Task | Test File | Layer | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|-----|-------|-------------|----------|
| 2.2 | `test/dependency-guard.test.ts` | Unit (manifest read) | ✅ Verified via throwaway `@neondatabase/serverless` addition — failed with `not.toContain` assertion | ✅ Passed after removal | ✅ 2 cases (absence + `pg` presence) | ➖ None needed |
| 2.3/2.4 | `test/client-env-guards.test.ts` | Unit (dynamic import + env stubbing) | ✅ Written first — failed with "Does the file exist?" for both `client.ts` and `admin.ts` | ✅ Passed after both files created | ✅ 7 cases (missing URL / bad host / override / good host, × client + admin) | ➖ None — guards are pure validation, no duplication to remove |
| 2.5/2.6 | `test/barrel-surface.test.ts` | Unit (dynamic import + source-text read) | ✅ Written first — 2/3 assertions failed (`src/index.ts` missing); exports-shape assertion started green (already correct from 2.1) | ✅ Passed after `src/index.ts` created | ✅ 3 angles (exports manifest, runtime shape, source-text re-export check) | ➖ None needed |
| 2.7 | `test/tenant.test.ts` (`assertUuid`) | Unit | ✅ Written first — failed with "Does the file exist?" | ✅ Passed after `src/tenant.ts` created | ✅ 3 cases (malformed, empty, valid) | ➖ None needed |
| 2.8/2.9 | `test/tenant.test.ts` (`withBrokerContext`) | Unit (mocked `db.transaction`, real `SQL.toQuery()` rendering) | ✅ Written first — failed with "Does the file exist?" | ✅ Passed after `src/tenant.ts` created | ✅ 2 cases (happy path SQL shape + guard-before-transaction) | ✅ Simplified `TenantDb` from a hand-rolled `PgTransaction<...>` generic to a `Parameters<...>` derivation after the first version failed `tsc` type-checking |
| 2.10 | `test/tenant-live-round-trip.test.ts` | Integration (live Postgres) | N/A — new file, no prior state to fail against | ⏸️ **Blocked/skipped** — no live connection in this environment | N/A | N/A |

### Test Summary (Phase 2)

- **Total tests written**: 18 (17 passing + 1 skipped)
- **Total tests passing**: 17/17 runnable; 1 explicitly skipped (not counted as passing)
- **Layers used**: Unit (17), Integration/live (1, blocked)
- **Pure functions created**: `assertUuid`, `withBrokerContext` (`packages/db/src/tenant.ts`)

## Files Changed (Phase 2)

| File | Action | What Was Done |
|------|--------|----------------|
| `packages/db/package.json` | Created | `pg`+`drizzle-orm` deps; `drizzle-kit`+`tsx`+`@types/pg`+`@dirus/config` devDeps; `exports` restricted to `.`/`./schema`; `db:generate`/`db:migrate`/`db:check` scripts |
| `packages/db/tsconfig.json` | Created | Extends `@dirus/config` base, includes `src`/`scripts`/`test` |
| `packages/db/vitest.config.ts` | Created | Extends `@dirus/config` shared Vitest base, adds `test/setup.ts` |
| `packages/db/test/setup.ts` | Created | Default placeholder `DATABASE_URL`/`DATABASE_URL_UNPOOLED` for tests that don't exercise the env guards |
| `packages/db/test/dependency-guard.test.ts` | Created | Driver enforcement (design.md D-A) |
| `packages/db/src/schema/index.ts` | Created | Empty placeholder (`export {}`); real tables land in Phase 3 |
| `packages/db/src/internal/client.ts` | Created | Pooled runtime client + `DATABASE_URL`/host guards (design.md D-B) |
| `packages/db/src/internal/admin.ts` | Created | Unpooled admin client + `DATABASE_URL_UNPOOLED`/host guards (design.md D-B/D-G) |
| `packages/db/test/client-env-guards.test.ts` | Created | 7 cases covering both clients' guards |
| `packages/db/src/index.ts` | Created | Public barrel — `withBrokerContext`, `assertUuid`, `TenantDb`, `schema` only (design.md D-C) |
| `packages/db/src/tenant.ts` | Created | `assertUuid` + `withBrokerContext` (design.md D-C/D-E) |
| `packages/db/test/barrel-surface.test.ts` | Created | Exports-map + barrel-shape + source-text non-bypassability checks |
| `packages/db/test/tenant.test.ts` | Created | `assertUuid` + `withBrokerContext` unit tests (mocked `db`) |
| `packages/db/test/tenant-live-round-trip.test.ts` | Created | Live pool-checkout leak test — **blocked/skipped**, no live DB |
| `pnpm-lock.yaml` | Modified | `pg`, `drizzle-orm`, `drizzle-kit`, `tsx`, `@types/pg` resolved |

## Verification Output (Phase 2)

```
$ pnpm --filter @dirus/db exec vitest run
 ✓ test/dependency-guard.test.ts (2 tests) 2ms
 ↓ test/tenant-live-round-trip.test.ts (1 test | 1 skipped)
 ✓ test/client-env-guards.test.ts (7 tests) 261ms
 ✓ test/barrel-surface.test.ts (3 tests) 268ms
 ✓ test/tenant.test.ts (5 tests) 264ms
 Test Files  4 passed | 1 skipped (5)
      Tests  17 passed | 1 skipped (18)

$ pnpm --filter @dirus/db exec tsc -p tsconfig.json --noEmit
(no output — zero errors)

$ pnpm -r run typecheck
Scope: 8 of 9 workspace projects
... all 8 packages: Done (zero errors)

$ pnpm -r run test
Scope: 8 of 9 workspace projects
packages/config: 4 tests passed
packages/db: 17 tests passed, 1 skipped
apps/api, apps/dashboard, apps/jobs, packages/agents, packages/integrations, packages/schemas:
  No test files found, exiting with code 0 (--passWithNoTests)

$ pnpm run lint:deps
✔ no dependency violations found (35 modules, 39 dependencies cruised)

$ pnpm run lint
(no output — zero ESLint problems)
```

## Deviations from Design (Phase 2)

- **Added task 2.10** (live round-trip test) beyond the literal task list.
  design.md D-A explicitly requires this test ("A second test proves the
  round trip...") but `tasks.md`'s Phase 2 section only lists the mocked
  SQL-shape test (2.8). Treated the design doc as authoritative for this
  specific non-negotiable per the user's explicit instruction. The test is
  written and gated behind `LIVE_TEST_DATABASE_URL`; it is **blocked/skipped**
  in this environment, not weakened to pass offline.
- **`packages/db/vitest.config.ts` + `test/setup.ts`** were not explicitly
  listed as tasks. Required because `src/tenant.ts` unconditionally imports
  `./internal/client.js` at module load time (by design — the barrel must
  wire through the real guarded client, not a lazy accessor), which means
  every test that imports `tenant.ts` or the barrel needs a valid-looking
  `DATABASE_URL` present, even tests unrelated to the env guards
  (`assertUuid`, `withBrokerContext` SQL-shape, barrel-shape checks).
  `test/setup.ts` supplies a placeholder pooled URL via `??=`;
  `client-env-guards.test.ts` deletes/overrides it per test via
  `vi.resetModules()` to test the guards themselves. No production code
  reads this placeholder — it never resolves a real connection because
  no test in this environment actually opens a socket except the skipped
  2.10 test.
- The dependency-cruiser deep-import rule design.md D-C mentions as bullet 4
  ("dependency-cruiser forbids deep imports matching `@dirus/db/(src|dist)/.*`")
  was **not added** — it is not in `tasks.md`'s Phase 2 task list, and the
  primary enforcement mechanism (`package.json#exports` restricting resolution
  to `.`/`./schema`, verified in `barrel-surface.test.ts`) already blocks deep
  imports at both the TypeScript and Node module-resolution level, which is
  the guarantee bullets 1-2 of D-C describe. Flagging as a possible low-cost
  follow-up, not a gap in the enforced guarantee.

## Issues Found (Phase 2)

- Drizzle's `SQL.toQuery(config)` requires a full `BuildQueryConfig`
  (`casing: CasingCache`, `escapeName`, `escapeParam`, `escapeString`), not
  just `escapeParam` — TypeScript caught this at `tsc` time even though the
  narrower object worked fine at runtime under Vitest's looser typing. Fixed
  by constructing a real `CasingCache` from `drizzle-orm/casing`.
- ESLint's `@typescript-eslint/no-unused-vars` flagged an unused `afterEach`
  import and an unused `_query` parameter left over from an earlier draft of
  `tenant.test.ts`'s mock; both removed before commit — `pnpm run lint` is
  the actual gate, not just `tsc`.

## Workload / PR Boundary (Phase 2)

- Mode: chained PR slice (`feature-branch-chain`)
- Current work unit: Unit 2 — DB Driver & Tenant Guards (fully satisfies
  design.md D-A/D-B/D-C/D-E; PR 2 in the chain, base =
  `feat/scaffold-monorepo-workspace-foundation`)
- Boundary: starts from the completed workspace-foundation slice (no
  `packages/db`) and ends with an installable, typecheckable, lint-clean
  `@dirus/db` package exposing only `withBrokerContext`/`assertUuid`/
  `TenantDb`/`schema`, with the Neon-HTTP-driver ban, both env/host guards,
  and the non-bypassable barrel all enforced by passing tests. Schema tables
  (Phase 3), migrations (Phase 4), the migration runner (Phase 5), and live
  RLS integration tests (Phase 6) are explicitly out of scope — `schema/index.ts`
  is an intentional empty placeholder.
- Review budget: `git diff --stat` unit1..unit2 (excluding `pnpm-lock.yaml`
  and `openspec/`) = **13 files changed, 524 insertions(+), 0 deletions(-)**.
  This exceeds the 400-line budget by ~31%. Not pre-accepted as
  `size:exception` by the user for this specific slice (only Phase 1's 479
  lines were explicitly accepted). Flagged as a risk requiring the same kind
  of decision before this slice is turned into an actual PR — kept as one
  commit-set because `client.ts`/`admin.ts` (env guards), `index.ts` (barrel
  restriction, whose test asserts `withBrokerContext` is exported), and
  `tenant.ts` (`withBrokerContext` itself) are mutually dependent: the
  barrel-surface test cannot pass without `tenant.ts` existing, and
  `tenant.ts` cannot be meaningfully tested without the guarded client
  underneath it. No push, no PR opened, per instructions — this is a local
  risk note for whoever turns this branch into a PR next.

## Phase 2 — Judgment Day Adversarial Review

- **Verdict**: APPROVED (3 rounds, 2 fix iterations).
- **Round 2 finding (CRITICAL)**: a credential leak in
  `parseHost`/`parse-host.ts`'s malformed-connection-string error path.
  The Round 1 fix itself introduced the bug: `url.slice(0, 20)` on the raw
  connection string, included in the thrown error message, reproduces the
  username and password verbatim for any standard `postgres://user:pass@...`
  URL (the scheme alone is 11 characters). Fixed in
  `packages/db/src/internal/parse-host.ts`, which now emits **nothing**
  derived from the raw `url` value in the error message — the function
  header comment documents why redaction-by-slicing is not safe once the
  value has already failed to parse (its structure is unknown, so there is
  no safe substring to keep).
- **Remaining known debt**: `packages/db/test/tenant-live-round-trip.test.ts`
  is still `describe.skipIf`-gated — no live Postgres connection is
  reachable in this sandboxed environment. The anti-leak, transaction-scoped
  `app.broker_id` guarantee is designed and structurally enforced
  (`withBrokerContext`, `set_config(..., true)` inside `db.transaction`,
  non-bypassable barrel) but **not yet demonstrated by an automated test**
  against a real Postgres connection. Must be run before this change is
  considered fully verified (tracked for Phase 6 / whenever a live Neon
  connection is available in CI).

## Phase 3: Schema (data-model §7.1/§7.2) — COMPLETE (5/5 tasks)

- [x] 3.1 RED/GREEN: `packages/db/test/schema/tables.test.ts` — table-by-table
      checklist against `docs/ARCHITECTURE.md` §7.1: every column's DB name,
      `getSQLType()`, `notNull`, default (rendered via the same
      `SQL.toQuery()` + `CasingCache` pattern as Phase 2's `tenant.test.ts`),
      and FK target (table + column) on all 9 tables. RED confirmed by
      temporarily moving the 9 new schema files out of `src/schema/` (leaving
      the Phase 2 `export {}` placeholder in place) and re-running the suite:
      28/29 new assertions failed with `schema.<table>` being `undefined`
      (`Cannot read properties of undefined (reading 'Symbol(drizzle:Columns)')`
      from `getTableConfig()`), confirming the tests exercised real production
      code paths, not tautologies. Files restored, GREEN confirmed on the
      first implementation pass (no iteration needed).
- [x] 3.2 RED/GREEN: same file, `doc_chunks is excluded` describe block —
      asserts no exported schema value resolves to a table named
      `doc_chunks`. Included in the same RED/GREEN cycle as 3.1 (same file,
      same move-out/restore).
- [x] 3.3 RED/GREEN: `packages/db/test/schema/chatwoot-columns.test.ts` — the
      4 §7.2 `chatwoot_*` columns each asserted `notNull === false`.
      **Interpreted structurally, not as a live INSERT**: this phase produces
      the Drizzle schema only (no generated migration yet — that is Phase 4
      — and no live Postgres connection is reachable in this environment,
      same constraint documented for Phase 2's 2.10 live round-trip test).
      "Insert without a value succeeds" and "column has no NOT NULL
      constraint" are the same guarantee at the schema level; the literal
      live-INSERT proof is deferred to Phase 6 (live Neon integration). Noted
      explicitly in the test file's docblock and in `tasks.md`.
- [x] 3.4 RED/GREEN: `packages/db/test/schema/unique-constraints.test.ts` —
      all 5 constraints from the task list: `brokers.wa_phone_number_id`
      (single-column `.isUnique`), `messages.wa_message_id` (single-column
      `.isUnique`), and the 3 composite constraints
      (`renewals(policy_id, due_date)`, `contacts(broker_id, phone)`,
      `broker_users(broker_id, phone)`) via `getTableConfig().uniqueConstraints`.
- [x] 3.5 GREEN: `packages/db/src/schema/{brokers,broker_users,contacts,
      conversations,messages,policies,documents,extractions,renewals}.ts` —
      every §7.1 column/type/default/FK, the §7.2 nullable `chatwoot_*`
      columns, the full index on `messages(conversation_id, created_at)`,
      the two partial indexes (`policies(broker_id, end_date) WHERE status =
      'active'`, `extractions(broker_id, needs_review) WHERE needs_review =
      true`, built with `eq()` from `drizzle-orm` passed to `.where()`), and
      every UNIQUE constraint. `src/schema/index.ts` updated from the Phase 2
      `export {}` placeholder to re-export all 9 tables.

### UUID Generation Strategy Decision (required by this batch's instructions)

**Decision: `gen_random_uuid()` / Drizzle's `.defaultRandom()` (UUID v4) for
every table's `id` primary key.** Every `id` column across all 9 schema files
uses `uuid("id").primaryKey().defaultRandom()`, which drizzle-orm compiles to
`DEFAULT gen_random_uuid()` — the same function `docs/ARCHITECTURE.md` §7.1's
literal SQL specifies for every table (`id uuid PRIMARY KEY DEFAULT
gen_random_uuid()`), and a v4 UUID.

**Consistency check**: `packages/db/src/tenant.ts`'s `UUID_RE` already
requires version nibble `[1-5]` and variant `[89ab]` — i.e. it already
accepts v1-v5 (in practice, only v4 is ever generated by
`gen_random_uuid()`), which is exactly what this decision produces. **No
change to `UUID_RE` was needed or made.** The comment in `tenant.ts` stating
"If Phase 3 changes the ID generation strategy... this regex MUST be
updated" is now stale (Phase 3 did not change the strategy) but was left
in place rather than edited, since editing `tenant.ts` is outside this
batch's Phase 3 scope (schema only) and the comment's conditional ("if...
changes") remains accurate — it simply didn't fire. Flagging this as a
candidate one-line comment cleanup for a future batch, not a defect.

### TDD Cycle Evidence (Phase 3)

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3.1/3.2 | `test/schema/tables.test.ts` | Unit (Drizzle table introspection via `getTableConfig()`) | N/A (new) | ✅ Verified — schema files moved out, 28/29 assertions failed with `Cannot read properties of undefined ('Symbol(drizzle:Columns)')` | ✅ Passed after all 9 schema files restored/created (first pass, no fix iteration) | ✅ 9 tables × up to 3 sub-cases each (core columns, chatwoot columns, index/constraint shape) — every table/column/default/FK is its own assertion | ➖ None needed — one `tsc` type-predicate fix (see Issues Found), no behavior change |
| 3.3 | `test/schema/chatwoot-columns.test.ts` | Unit (`getTableConfig()`) | N/A (new) | ✅ Verified via the same move-out RED run (barrel export undefined) | ✅ Passed after schema restored | ✅ `it.each` over all 4 chatwoot columns across 4 different tables | ➖ None needed |
| 3.4 | `test/schema/unique-constraints.test.ts` | Unit (`getTableConfig()`) | N/A (new) | ✅ Verified via the same move-out RED run | ✅ Passed after schema restored | ✅ 2 single-column cases + `it.each` over 3 composite cases | ➖ None needed |
| 3.5 | (production code, covered by 3.1-3.4's tests) | N/A | N/A (new files) | N/A — implementation task, not a test-authoring task | ✅ All 29 schema tests pass against it | N/A | N/A |

### Test Summary (Phase 3)

- **Total tests written**: 29 (20 in `tables.test.ts`, 4 in
  `chatwoot-columns.test.ts`, 5 in `unique-constraints.test.ts`)
- **Total tests passing**: 29/29
- **Layers used**: Unit (29) — Drizzle schema introspection, no I/O
- **Approval tests** (refactoring): None — no refactoring tasks in Phase 3
  (all new files)
- **Pure functions created**: 0 new exported production functions (Phase 3
  is declarative schema — table/column definitions, not logic). The test
  file's `renderDefault`/`assertColumn`/`assertUniqueConstraint` are test
  helpers, not production code, and are not exported.

## Files Changed (Phase 3)

| File | Action | What Was Done |
|------|--------|----------------|
| `packages/db/src/schema/brokers.ts` | Created | `brokers` table — tenant root, `wa_phone_number_id` UNIQUE, `chatwoot_account_id` |
| `packages/db/src/schema/broker_users.ts` | Created | `broker_users` table — FK to `brokers`, `UNIQUE(broker_id, phone)` |
| `packages/db/src/schema/contacts.ts` | Created | `contacts` table — FK to `brokers`, `UNIQUE(broker_id, phone)`, `chatwoot_contact_id` |
| `packages/db/src/schema/conversations.ts` | Created | `conversations` table — FKs to `brokers`/`contacts`/`broker_users`, `chatwoot_conversation_id` |
| `packages/db/src/schema/messages.ts` | Created | `messages` table — FKs to `brokers`/`conversations`, `wa_message_id` UNIQUE, `chatwoot_message_id`, index on `(conversation_id, created_at)` |
| `packages/db/src/schema/policies.ts` | Created | `policies` table — FKs to `brokers`/`contacts`, partial index `(broker_id, end_date) WHERE status = 'active'` |
| `packages/db/src/schema/documents.ts` | Created | `documents` table — FKs to `brokers`/`policies`/`contacts`/`messages` |
| `packages/db/src/schema/extractions.ts` | Created | `extractions` table — FKs to `brokers`/`documents`/`messages`/`broker_users`, partial index `(broker_id, needs_review) WHERE needs_review = true` |
| `packages/db/src/schema/renewals.ts` | Created | `renewals` table — FKs to `brokers`/`policies`/`conversations`, `UNIQUE(policy_id, due_date)` |
| `packages/db/src/schema/index.ts` | Modified | Barrel now re-exports all 9 tables (was the Phase 2 `export {}` placeholder) |
| `packages/db/test/schema/tables.test.ts` | Created | Table-by-table §7.1 checklist (20 tests) + `doc_chunks` exclusion |
| `packages/db/test/schema/chatwoot-columns.test.ts` | Created | §7.2 nullable chatwoot columns (4 tests) |
| `packages/db/test/schema/unique-constraints.test.ts` | Created | Idempotency UNIQUE constraints (5 tests) |

## Verification Output (Phase 3)

```
$ pnpm --filter @dirus/db exec vitest run test/schema
 ✓ test/schema/unique-constraints.test.ts (5 tests) 2ms
 ✓ test/schema/chatwoot-columns.test.ts (4 tests) 2ms
 ✓ test/schema/tables.test.ts (20 tests) 8ms
 Test Files  3 passed (3)
      Tests  29 passed (29)

$ pnpm --filter @dirus/db exec vitest run
 ✓ test/dependency-guard.test.ts (2 tests)
 ↓ test/tenant-live-round-trip.test.ts (1 test | 1 skipped)
 ✓ test/schema/unique-constraints.test.ts (5 tests)
 ✓ test/schema/chatwoot-columns.test.ts (4 tests)
 ✓ test/schema/tables.test.ts (20 tests)
 ✓ test/barrel-surface.test.ts (3 tests)
 ✓ test/tenant.test.ts (8 tests)
 ✓ test/client-env-guards.test.ts (9 tests)
 Test Files  7 passed | 1 skipped (8)
      Tests  51 passed | 1 skipped (52)

$ pnpm --filter @dirus/db exec tsc -p tsconfig.json --noEmit
(no output — zero errors)

$ pnpm -r run typecheck
Scope: 8 of 9 workspace projects
... all 8 packages: Done (zero errors)

$ pnpm -r run test
Scope: 9 of 9 workspace projects (packages/db now has schema content too)
packages/config: 4 tests passed
packages/db: 51 tests passed, 1 skipped
apps/api, apps/dashboard, apps/jobs, packages/agents, packages/integrations, packages/schemas:
  No test files found, exiting with code 0 (--passWithNoTests)

$ pnpm run lint:deps
✔ no dependency violations found (50 modules, 95 dependencies cruised)

$ pnpm run lint
(no output — zero ESLint problems)
```

## Deviations from Design (Phase 3)

- **Tasks 3.1/3.3/3.4 interpreted as structural (Drizzle table introspection
  via `getTableConfig()`), not live-database tests.** The literal task
  wording for 3.3 says "insert without value successfully" and design.md's
  Testing Strategy table lists a "Migration" layer using "Assert on
  committed SQL text" for partial indexes — but no migration exists yet
  (Phase 4) and no live Postgres connection is available in this
  environment. Treated as the correct interpretation for a schema-only
  phase, consistent with how Phase 2 treated the 2.10 live round-trip test
  (documented as a known limitation, not silently weakened, not skipped
  without an explicit gate). If this interpretation is wrong, the fix is a
  Phase 4/6 addition (static-SQL text assertions on the generated
  migration, then live INSERT/UNIQUE-violation tests against Neon), not a
  change to Phase 3's schema.
- **UUID strategy**: no deviation — `gen_random_uuid()`/v4 was chosen and
  matches the pre-existing `UUID_RE` in `tenant.ts` with zero changes
  required. See "UUID Generation Strategy Decision" above.
- **Spec vs. design agreement**: no conflict found between
  `specs/data-model/spec.md` §7.1/§7.2 requirements and `design.md`'s File
  Changes table for this phase — both describe the same 9 tables, the same
  two partial indexes, and the same 5 UNIQUE constraints. Nothing was
  reinterpreted or weakened.

## Issues Found (Phase 3)

- The `doc_chunks`-exclusion test (3.2) initially used a TypeScript type
  predicate (`(value): value is PgTable => ...`) to filter `Object.values(schema)`.
  `tsc` rejected it: each table's inferred type is a *distinct*
  `PgTableWithColumns<{name: "brokers"; ...}>` literal-name type, and a
  type predicate's return type must be assignable to the union of all of
  them, which a single `PgTable` narrowing is not. Fixed by dropping the
  type predicate and casting inside `.map()` instead (`getTableName(table
  as PgTable)`) — no behavior change, `tsc` clean.
- `eq()` is exported from `drizzle-orm`, not `drizzle-orm/pg-core` (the
  partial-index columns/builders are pg-core-specific, but SQL operators
  like `eq`/`and`/`or` live in the dialect-agnostic core package). Caught
  immediately by `tsc`/import resolution while writing `policies.ts` and
  `extractions.ts`; fixed by splitting the import into two statements.

## Workload / PR Boundary (Phase 3)

- Mode: chained PR slice (`feature-branch-chain`)
- Current work unit: Phase 3 — Schema (fully satisfies `data-model` spec's
  Core Schema Tables / Chatwoot Mirror Columns / Required Indexes /
  Idempotency Constraints requirements; PR 3 in the chain, base =
  `feat/scaffold-monorepo-db-driver-tenant-guards`)
- Boundary: starts from the completed DB-driver-and-tenant-guards slice
  (schema barrel was an empty `export {}` placeholder) and ends with all 9
  §7.1 tables + §7.2 chatwoot columns fully defined, typechecked, and
  covered by 29 passing structural tests. Migrations (Phase 4), the
  migration runner (Phase 5), and live RLS integration tests (Phase 6) are
  explicitly out of scope for this batch, per the hard scope boundary in
  the apply instructions — no migration SQL was generated.
- Review budget: `git diff --stat` unit2..unit3 (excluding `pnpm-lock.yaml`
  and `openspec/`) = **13 files changed, 912 insertions(+), 5
  deletions(-)**. This exceeds the 400-line budget by ~128% (~2.3x). Not
  pre-accepted as `size:exception` by the user for this specific slice.
  Flagged as a risk requiring the same kind of decision Phase 1/2 needed —
  kept as one commit because the 9 schema files are mutually dependent via
  `.references()` (a DAG: `broker_users`/`contacts` → `brokers`;
  `conversations` → `brokers`/`contacts`/`broker_users`; `messages` →
  `brokers`/`conversations`; `policies` → `brokers`/`contacts`;
  `documents` → `brokers`/`policies`/`contacts`/`messages`; `extractions`
  → `brokers`/`documents`/`messages`/`broker_users`; `renewals` →
  `brokers`/`policies`/`conversations`), so no subset of them typechecks or
  passes its tests in isolation — and because the ~562-line
  `tables.test.ts` is one exhaustive per-column checklist that either fully
  covers §7.1 or doesn't (splitting it per-table would leave intermediate
  commits either failing or covering an arbitrary subset of the spec).
  Given the schema itself is inherently a single interconnected unit
  (unlike Phase 1/2's driver+guards, which had some internal
  seams), splitting further would require either committing tables that
  don't yet typecheck (broken intermediate state) or duplicating the
  checklist test across multiple commits. **This is a local risk note for
  whoever turns this branch into a PR next** — the same treatment given to
  Phase 2's 524-line, non-pre-accepted overage.

## Phase 3.5 (untracked in this doc): CI workflow — COMPLETE

Branch `feat/scaffold-monorepo-ci-workflow` (commit `be6aea5`) added
`.github/workflows/ci.yml` with a `pgvector/pgvector:pg17` service
container, wiring `LIVE_TEST_DATABASE_URL` (only) for the test step. This
predates this apply batch and was not recorded in this file by whichever
batch produced it; noted here for continuity since Phase 4 depends on it
directly (see below).

## Phase 4: Migrations (design D-D/D-F/D-G) — COMPLETE (8/8 tasks)

- [x] 4.1 GREEN: `pnpm exec drizzle-kit generate` → `migrations/0000_init.sql`
      (renamed from drizzle-kit's default `0000_<adjective>_<noun>.sql`
      naming; `meta/_journal.json`'s `tag` field updated to match). Required
      bumping `drizzle-kit` from `^0.30.1` to `^0.31.10` in
      `packages/db/package.json` — 0.30.x's schema loader could not resolve
      the schema files' NodeNext-style relative `.js` imports at all
      (`Cannot find module './brokers.js'`, since its loader transpiles each
      file with `esbuild.transformSync` — no bundling — so `require("./brokers.js")`
      is issued verbatim against a filesystem that only has `brokers.ts`).
      0.31.10 resolves this correctly against both a `schema: "./src/schema/*.ts"`
      glob and, once confirmed working, the cleaner
      `schema: "./src/schema/index.ts"` single entry point (kept in
      `drizzle.config.ts`).
- [x] 4.2 RED/GREEN: `test/migrations/partial-indexes.test.ts` — asserts the
      committed `0000_init.sql` keeps both partial indexes' `WHERE` clauses
      verbatim, plus a general "never emits an unbound `$N` placeholder"
      regression guard. **RED verified for real, not assumed**: the first
      `drizzle-kit generate` run produced
      `WHERE "policies"."status" = $1` / `WHERE "extractions"."needs_review" = $1`
      — `eq(table.status, "active")`/`eq(table.needsReview, true)` (Phase 3's
      original partial-index builders) render as a *bound* parameter
      placeholder in generated migration SQL, which is invalid inside a raw
      DDL statement (no parameter binding exists at migration-apply time).
      Fixed by switching `packages/db/src/schema/{policies,extractions}.ts`
      to the `sql` tag (`sql\`${table.status} = 'active'\``,
      `sql\`${table.needsReview} = true\``), which embeds the literal
      directly. Confirmed RED again by corrupting a copy of the real,
      already-fixed migration back to `$1` and re-running the test suite (3/3
      failed), then restoring and confirming GREEN (3/3 passed). **This
      required updating two pre-existing Phase 3 tests**
      (`test/schema/tables.test.ts`'s two partial-index assertions), which
      had asserted the old `eq()`-based bound-parameter rendering
      (`params: ["active"]`/`params: [true]`) — now assert the `sql`-tag
      literal rendering (`params: []`, literal embedded in `whereSql`).
- [x] 4.3 GREEN: `pnpm exec drizzle-kit generate --custom --name=vector_extension`
      → `migrations/0001_vector_extension.sql` (`CREATE EXTENSION IF NOT
      EXISTS vector;`). RED/GREEN test: `test/migrations/vector-extension.test.ts`
      — RED confirmed by temporarily emptying the migration file's content
      (drizzle-kit's placeholder comment) and re-running (1/2 assertions
      failed); restored and confirmed GREEN (2/2). Second assertion scans
      **every** committed migration file for a `vector(N)` column
      declaration (regex requires a numeric dimension, e.g. `vector(1536)`,
      specifically so it does not false-positive on the migration's own
      prose comment mentioning "vector(...) column").
- [x] 4.4 RED: `test/migrations/rls-policies.test.ts` — written against
      `migrations/0002_rls_policies.sql` before that file had real content;
      confirmed failing with `ENOENT` (file didn't exist yet at all,
      stronger RED than a content mismatch). Asserts, per D-D's surfaced
      spec gap: every one of the 9 `broker_id`/`id` tables has both `ENABLE`
      and `FORCE ROW LEVEL SECURITY`, a `CREATE POLICY tenant_isolation ...
      FOR ALL` with **both** `USING` and `WITH CHECK` clauses (not
      `USING`-only — the exact gap the cross-tenant INSERT scenario closes),
      a policy-count-equals-WITH-CHECK-count structural invariant (so a
      regression to a `USING`-only policy on even one table is caught, not
      just the two explicitly enumerated), and that the 1-argument
      `current_setting('app.broker_id')` form (which raises instead of
      failing closed, per design.md D-E) never appears anywhere in the file.
- [x] 4.5 GREEN: `migrations/0002_rls_policies.sql` — `brokers` keyed on
      `id`, the other 8 tables keyed on `broker_id`, each with
      `ENABLE`+`FORCE ROW LEVEL SECURITY` and a `FOR ALL USING (...) WITH
      CHECK (...)` policy using
      `nullif(current_setting('app.broker_id', true), '')::uuid`
      (design.md D-D/D-E verbatim). 11/11 tests in
      `rls-policies.test.ts` pass.
- [x] 4.6 GREEN: `migrations/0003_app_role_grants.sql` — `DO $$ ... END $$`
      block guarded by `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname =
      'dirus_app')`, granting schema USAGE, table SELECT/INSERT/UPDATE/DELETE,
      sequence USAGE/SELECT, and `ALTER DEFAULT PRIVILEGES` for future
      tables — never `CREATE ROLE` itself (design.md D-F: that carries
      password material and is a one-time operational step, kept out of the
      committed migration sequence). RED/GREEN cycle documented in
      `test/migrations/app-role-grants.test.ts` (4/4 tests): RED confirmed
      by emptying the migration file (3/4 failed — the "never creates the
      role" assertion trivially passed against empty content, correctly so),
      restored and confirmed GREEN (4/4).
- [x] 4.7 Created `packages/db/scripts/provision-app-role.sql` — documented
      one-time step (`CREATE ROLE dirus_app WITH LOGIN PASSWORD :'app_password'
      NOBYPASSRLS NOSUPERUSER`), with a docblock explaining why it's outside
      `migrations/` (secret material; Neon-account-scoped) and the Neon
      caveat from design.md D-F (console-created roles inherit
      `neon_superuser`'s `BYPASSRLS` — this script is the only correct way
      to create the role).
- [x] 4.8 RED/GREEN: `test/migrations/drift.test.ts` — runs the real
      `pnpm exec drizzle-kit check` as a subprocess and asserts
      `Everything's fine` in its output. **RED verified against a real
      race-condition collision, not a schema-content mismatch** (a schema
      column addition was tried first and found *not* to trigger `check` —
      confirmed `check` validates journal/snapshot lineage integrity, i.e.
      protects against two migrations both claiming to follow the same
      parent snapshot in a branching-race scenario, not schema-vs-migration
      content drift, which is `generate`'s job): duplicated
      `meta/0003_snapshot.json` into a `meta/0004_snapshot.json` sharing the
      same `prevId`, appended a matching journal entry, ran `drizzle-kit
      check` directly (exit 1, `"[migrations/meta/0003_snapshot.json,
      migrations/meta/0004_snapshot.json] are pointing to a parent snapshot
      ... which is a collision."`) and then via the Vitest test itself
      (failed as expected), then removed the injected files/journal entry
      and confirmed GREEN.

### Live-Postgres Verification (beyond the literal task list — required by
this batch's instructions)

Structural SQL-text assertions (4.2/4.4/4.6/4.8 above) prove the migrations
*declare* the right SQL but cannot prove Postgres *enforces* it — RLS is
hand-written security SQL, not Drizzle-generated schema, and this batch's
instructions required proving it against a real `pgvector/pgvector:pg17`
container, not just static inspection.

**Two layers of evidence were produced:**

1. **Manual verification** (this session, containers since torn down):
   started `pgvector/pgvector:pg17` via `docker run`, applied
   `0000`→`0002` as the Postgres superuser, provisioned `dirus_app` via
   `provision-app-role.sql`, applied `0003`, seeded a two-broker fixture,
   and ran every one of the six required checks directly via `psql`/`docker
   exec` (full transcript in this session's tool output). All six passed,
   including a **negative control** for FORCE (temporarily
   `NO FORCE ROW LEVEL SECURITY` on `policies`, showing the *same*
   non-superuser owner, *same* unset session, then *does* see rows —
   proving `ENABLE` alone would not have caught this).
2. **Committed, repeatable test**:
   `packages/db/test/migrations/live-rls-verification.test.ts` (6 tests),
   gated by `LIVE_TEST_DATABASE_URL` (`describe.skipIf`, same convention as
   the pre-existing `test/tenant-live-round-trip.test.ts`). Creates
   `phase4_owner`/`phase4_app` roles and the 9 tables directly in the
   `public` schema of whatever `LIVE_TEST_DATABASE_URL` points at
   (**not** an isolated schema — `0000_init.sql`'s FKs are generated as
   fully-qualified `REFERENCES "public"."<table>"`, so relocating tables via
   `search_path` does not work), seeds the same two-broker fixture, asserts
   all six points, then drops everything it created in `afterAll` (verified
   idempotent by running the file twice back-to-back locally with no
   failures). **CI already wires `LIVE_TEST_DATABASE_URL` to its
   `pgvector/pgvector:pg17` service container** (`.github/workflows/ci.yml`,
   added on the prior `ci-workflow` branch) — zero CI changes were needed
   for this test to run on every push.

**The six points, and how each is proven (both manually and by the
committed test):**

1. **`FORCE` (not `ENABLE` alone) binds the table owner.** A dedicated
   non-superuser, non-`BYPASSRLS` role (`phase4_owner`/manually
   `dirus_owner`) applies `0000`+`0002` and becomes the real table owner
   (confirmed via `pg_tables.tableowner`). A fresh session by that same
   role, with `app.broker_id` never set, returns **zero rows** from
   `policies`. **Negative control**: with `NO FORCE ROW LEVEL SECURITY`
   applied to the same table, the exact same owner/session query returns
   **>0 rows** — proving `FORCE` is the load-bearing clause, not `ENABLE`.
2. **Unset broker context returns zero rows, including the `''` edge
   case.** As the app role (`phase4_app`/manually `dirus_app`), a fresh
   session with no `app.broker_id` set: `SELECT count(*) FROM policies` →
   `0`. Explicitly `SELECT set_config('app.broker_id', '', true)` inside a
   transaction: also `0`, no error (`nullif(..., '')` guards the `''::uuid`
   cast that would otherwise raise).
3. **Cross-tenant read, update, delete are all blocked.** Broker A's
   session sees exactly 1 row (its own); `UPDATE ... WHERE id = <B's row>`
   → `0` rows affected; `DELETE ... WHERE id = <B's row>` → `0` rows
   affected; B's row confirmed unchanged afterward via the admin/superuser
   connection.
4. **Cross-tenant INSERT is blocked (`WITH CHECK`).** Broker A's session
   attempting `INSERT ... (broker_id, ...) VALUES (<B's id>, ...)` fails
   with `ERROR: new row violates row-level security policy for table
   "policies"` and the transaction rolls back — the exact D-D spec-gap
   scenario; a `USING`-only policy would have allowed this.
5. **The application role is non-owner, non-superuser, non-`BYPASSRLS`.**
   Verified from `pg_roles.rolsuper`/`rolbypassrls` (both `false`) and
   `pg_tables.tableowner` (not the app role) — from the catalog, not the
   migration's own text.
6. **Partial indexes keep their explicit `WHERE` clauses.** Covered by
   4.2's static test (`rls-policies.test.ts`/`partial-indexes.test.ts`);
   not re-verified live since it's an index-shape guarantee, not a
   behavioral RLS guarantee — `EXPLAIN`-based confirmation that the planner
   actually chooses the partial index is a Phase 6 concern (needs
   representative data volume), not a Phase 4 one.

**Scope note**: this live verification does not start or advance Phase 6
("Live RLS Integration") — Phase 6 owns the full two-broker fixture across
`contacts`/`messages` (not just `policies`), a seeded fixture against a real
Neon project specifically, and running `provision-app-role.sql` against
that target project. All 7 Phase 6 tasks remain `[ ]`, unstarted. This
batch's live verification exists because hand-written security SQL cannot
be responsibly verified by structural inspection alone, per this batch's
explicit instructions — it is evidence for Phase 4's own migration files,
committed as a regression test, not a substitute for Phase 6.

### TDD Cycle Evidence (Phase 4)

| Task | Test File | Layer | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|-----|-------|-------------|----------|
| 4.1/4.2 | `test/migrations/partial-indexes.test.ts` | Static (SQL text) | ✅ Verified twice — once for real (first `drizzle-kit generate` run produced literal `$1` placeholders), once by deliberately corrupting a restored copy | ✅ Passed after switching `policies.ts`/`extractions.ts` to the `sql` tag | ✅ 2 explicit table cases + 1 general "no unbound `$N` anywhere" regression guard | ➖ None needed — schema fix was the correct shape, not duplication |
| 4.3 | `test/migrations/vector-extension.test.ts` | Static (SQL text, scans all migration files) | ✅ Verified — emptied migration content, 1/2 failed | ✅ Passed after real content restored | ✅ 2 angles (extension statement present; no `vector(N)` column in ANY migration file) | ➖ None needed |
| 4.4/4.5 | `test/migrations/rls-policies.test.ts` | Static (SQL text) | ✅ Verified — file didn't exist yet, `ENOENT` | ✅ Passed after `0002_rls_policies.sql` written (first pass, no fix iteration) | ✅ 9 tables (1 `id`-keyed + 8 `broker_id`-keyed via `it.each`) + 2 structural invariants (WITH-CHECK-count, no 1-arg `current_setting`) | ➖ None needed |
| 4.6 | `test/migrations/app-role-grants.test.ts` | Static (SQL text) | ✅ Verified — emptied migration content, 3/4 failed | ✅ Passed after real content restored | ✅ 4 angles (guard clause, no bare CREATE ROLE, 3 grant statements, default privileges) | ➖ None needed |
| 4.8 | `test/migrations/drift.test.ts` | Integration (subprocess: real `drizzle-kit check`) | ✅ Verified against a genuine race-condition collision (not a false-positive trigger — schema drift alone does NOT fail `check`, confirmed by trying that first) | ✅ Passed after injected collision files/journal entry removed | ✅ Single (the one behavior `check` actually guards: journal/snapshot lineage collisions) | ➖ None needed |
| (live verification) | `test/migrations/live-rls-verification.test.ts` | Integration (live Postgres, `pgvector/pgvector:pg17`) | N/A — new file; manual `psql`/`docker exec` verification done first to derive the correct fixture/assertion shape, then encoded as a committed test | ✅ 6/6 passing against a real container (twice, to confirm idempotent cleanup) | ✅ 6 distinct guarantees, including 1 negative control (FORCE vs. ENABLE) | ➖ None needed |
| (regression) | `test/schema/tables.test.ts` (2 pre-existing Phase 3 assertions) | Unit (Drizzle introspection) | N/A — these were passing Phase 3 tests that the `sql`-tag schema fix broke; updated to match the new (correct) rendering, not weakened | ✅ Passed after updating `params`/`whereSql` expectations | N/A — regression fix, not new behavior | ➖ None needed |

### Test Summary (Phase 4)

- **Total tests written**: 21 static + 6 live-integration = 27 new; plus 2
  pre-existing Phase 3 tests updated (not new, not weakened — corrected to
  match the `sql`-tag rendering)
- **Total tests passing**: 27/27 new tests pass; full `packages/db` suite
  (with `LIVE_TEST_DATABASE_URL` set against a real container) = 79/79
  passing, 0 skipped. Without a live connection (default local/CI-absent
  state): 72/79 passing, 7 skipped (the 6 new live-RLS tests +
  Phase 2's pre-existing live round-trip test) — correctly gated, not
  silently weakened.
- **Layers used**: Static/SQL-text (21), Integration/subprocess (1,
  `drizzle-kit check`), Integration/live-Postgres (6, this batch's addition
  + 1 pre-existing from Phase 2, now demonstrated passing for the first
  time in this environment)
- **Approval tests** (refactoring): None — no refactoring tasks in Phase 4
- **Pure functions/production code created**: 0 new exported TypeScript
  functions (Phase 4 is SQL migrations + a config file); the 2 schema files
  modified (`policies.ts`, `extractions.ts`) changed an index-builder
  expression, not new logic

## Files Changed (Phase 4)

| File | Action | What Was Done |
|------|--------|----------------|
| `packages/db/drizzle.config.ts` | Created | `dialect: "postgresql"`, `schema: "./src/schema/index.ts"`, `out: "./migrations"`, `dbCredentials.url` from `DATABASE_URL_UNPOOLED` (placeholder fallback so `check`/`generate` never need a real connection) |
| `packages/db/package.json` | Modified | `drizzle-kit` bumped `^0.30.1` → `^0.31.10` (0.30.x could not resolve the schema's NodeNext `.js`-extension relative imports) |
| `packages/db/src/schema/policies.ts` | Modified | Partial index predicate: `eq(table.status, "active")` → `sql\`${table.status} = 'active'\`` (avoids an unbound `$1` in generated migration SQL) |
| `packages/db/src/schema/extractions.ts` | Modified | Same fix: `eq(table.needsReview, true)` → `sql\`${table.needsReview} = true\`` |
| `packages/db/migrations/0000_init.sql` | Created | Generated: 9 tables, FKs, UNIQUEs, all indexes incl. both partial indexes with literal `WHERE` clauses |
| `packages/db/migrations/0001_vector_extension.sql` | Created | `CREATE EXTENSION IF NOT EXISTS vector;` |
| `packages/db/migrations/0002_rls_policies.sql` | Created | `ENABLE`+`FORCE ROW LEVEL SECURITY` and `FOR ALL USING/WITH CHECK` policy on all 9 tables |
| `packages/db/migrations/0003_app_role_grants.sql` | Created | Guarded `DO` block granting `dirus_app` |
| `packages/db/migrations/meta/{_journal.json,0000-0003_snapshot.json}` | Created | drizzle-kit-managed migration history (0001-0003 snapshots are lineage-chained copies of 0000's, per D-G: custom migrations don't touch the snapshot) |
| `packages/db/scripts/provision-app-role.sql` | Created | One-time `CREATE ROLE dirus_app` step, documented, kept out of migrations |
| `packages/db/test/migrations/partial-indexes.test.ts` | Created | Static SQL-text checks on `0000_init.sql`'s partial indexes |
| `packages/db/test/migrations/vector-extension.test.ts` | Created | Static SQL-text checks on `0001_vector_extension.sql` + all-migrations `vector(N)`-column scan |
| `packages/db/test/migrations/rls-policies.test.ts` | Created | Static SQL-text checks on `0002_rls_policies.sql` (9 tables × ENABLE/FORCE/USING/WITH CHECK) |
| `packages/db/test/migrations/app-role-grants.test.ts` | Created | Static SQL-text checks on `0003_app_role_grants.sql` |
| `packages/db/test/migrations/drift.test.ts` | Created | Runs real `drizzle-kit check` as a subprocess, asserts zero drift |
| `packages/db/test/migrations/live-rls-verification.test.ts` | Created | Live-Postgres integration test proving all 6 RLS guarantees against a real `pgvector/pgvector:pg17` connection (`LIVE_TEST_DATABASE_URL`-gated) |
| `packages/db/test/schema/tables.test.ts` | Modified | 2 pre-existing partial-index assertions updated from `eq()`-bound-param expectations to `sql`-tag-literal expectations |
| `pnpm-lock.yaml` | Modified | `drizzle-kit` resolved to `0.31.10` |

## Verification Output (Phase 4)

```
$ pnpm --filter @dirus/db exec drizzle-kit check
Everything's fine 🐶🔥

$ pnpm --filter @dirus/db exec vitest run   (no live connection)
 ✓ test/migrations/partial-indexes.test.ts (3 tests)
 ✓ test/migrations/rls-policies.test.ts (11 tests)
 ↓ test/tenant-live-round-trip.test.ts (1 test | 1 skipped)
 ✓ test/migrations/app-role-grants.test.ts (4 tests)
 ✓ test/migrations/vector-extension.test.ts (2 tests)
 ✓ test/schema/unique-constraints.test.ts (5 tests)
 ✓ test/barrel-surface.test.ts (3 tests)
 ✓ test/schema/tables.test.ts (20 tests)
 ✓ test/tenant.test.ts (8 tests)
 ↓ test/migrations/live-rls-verification.test.ts (6 tests | 6 skipped)
 ✓ test/dependency-guard.test.ts (2 tests)
 ✓ test/schema/chatwoot-columns.test.ts (4 tests)
 ✓ test/client-env-guards.test.ts (9 tests)
 ✓ test/migrations/drift.test.ts (1 test)
 Test Files  12 passed | 2 skipped (14)
      Tests  72 passed | 7 skipped (79)

$ docker run -d --name dirus-pg4-verify -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dirus_verify \
    -p 55434:5432 pgvector/pgvector:pg17
$ LIVE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55434/dirus_test \
    pnpm --filter @dirus/db exec vitest run
 ✓ test/migrations/live-rls-verification.test.ts (6 tests) 386ms
 ✓ test/tenant-live-round-trip.test.ts (1 test) 50ms
 (+ all 12 other files, unchanged)
 Test Files  14 passed (14)
      Tests  79 passed (79)
# ...and manual psql verification of all 6 RLS points (see "Live-Postgres
# Verification" section above); container removed afterward.

$ rm -rf node_modules packages/*/node_modules apps/*/node_modules
$ pnpm install
Done (clean install from lockfile)

$ pnpm -r run typecheck
Scope: 8 of 9 workspace projects — all Done, zero errors

$ pnpm -r run test   (no live connection — clean-install baseline)
packages/db: 72 tests passed, 7 skipped
(all other packages: no test files / passed, unchanged from Phase 3)

$ pnpm run lint
(no output — zero ESLint problems)

$ pnpm run lint:deps
✔ no dependency violations found (59 modules, 115 dependencies cruised)
```

## Deviations from Design (Phase 4)

- **`drizzle-kit` version bump** (`^0.30.1` → `^0.31.10`), not listed in
  `tasks.md`. Required — 0.30.x's schema loader cannot resolve the
  project's NodeNext-style `.js`-extension relative imports at all
  (`generate`/`check` fail outright with `MODULE_NOT_FOUND`, not a
  degraded/wrong result). No behavior change to the schema itself; purely
  an implementation-detail fix to make `drizzle-kit` runnable in this
  workspace's tsconfig.
- **`policies.ts`/`extractions.ts` partial-index predicate rewritten**
  (`eq()` → `sql` tag), not listed in `tasks.md`. Required — the `eq()`
  form is a genuine drizzle-kit bug/limitation for partial-index `.where()`
  clauses specifically (it has no query-parameter binding to render
  against in raw DDL), confirmed by watching the real first `generate` run
  produce broken `$1` SQL. This is a bugfix to Phase 3's schema, not a
  design deviation — the *intended* SQL (`WHERE status = 'active'`) is
  unchanged; only the Drizzle builder API used to produce it changed.
- **Live-Postgres verification added beyond the literal Phase 4 task list**
  (`test/migrations/live-rls-verification.test.ts` + this batch's manual
  `psql` session), per this batch's explicit instructions that structural
  inspection alone cannot responsibly verify hand-written RLS SQL. Explicit
  scope note: this does NOT start or complete Phase 6 — see the "Scope
  note" paragraph above. All 7 Phase 6 tasks remain `[ ]`.
- **No conflict found** between `data-model/spec.md`'s literal
  `current_setting('app.broker_id')::uuid` wording (1-arg form, no
  `nullif`) and design.md D-D/D-E's 2-arg + `nullif` form — design.md
  explicitly documents this as the correct, load-bearing choice (D-E: "the
  two-argument form is load-bearing") and Phase 3's apply-progress already
  established the precedent of treating design.md as authoritative over
  literal spec wording where the design doc itself calls out the
  discrepancy. Implemented per design.md; not a new deviation introduced by
  this batch.

## Issues Found (Phase 4)

- `drizzle-kit generate`'s `eq()`-based partial-index predicate renders as
  an unbound `$1`/`$2` placeholder in the generated SQL file — a
  parameterized-query artifact leaking into raw DDL, where no parameter
  binding exists. This is silent: `generate` reports success, the file
  looks plausible at a glance, and only a static-SQL assertion (or
  attempting to actually apply the migration) reveals the bug. Fixed via
  the `sql` tag; documented with an inline comment in both schema files and
  the corresponding test files so a future contributor reaching for `eq()`
  in a partial-index `.where()` sees the warning before reintroducing it.
- `drizzle-kit check` does **not** detect schema-vs-migration content drift
  (e.g., a new column with no corresponding migration) — confirmed by
  direct experiment (added a throwaway column, ran `check`, got
  `Everything's fine`; ran `generate`, got a real proposed `ALTER TABLE ADD
  COLUMN`). `check` only validates migration-history/journal-lineage
  integrity (race conditions between two migrations both claiming to
  follow the same parent snapshot). Task 4.8's wording ("`drizzle-kit
  check` reports zero drift") is satisfied literally — that IS what `check`
  checks — but a future reader should not assume `check` catches schema
  drift; `generate` (with an empty diff) is the tool for that, and is
  implicitly covered by 4.8's RED/GREEN cycle producing no accidental
  migration files during this batch.
- `drizzle-kit generate`'s live-container migration test
  (`live-rls-verification.test.ts`) initially tried isolating all created
  objects in a dedicated Postgres *schema* (`phase4_rls_verify`) for
  cleaner idempotent teardown via `DROP SCHEMA ... CASCADE`. This failed:
  `0000_init.sql`'s foreign keys are generated as fully-qualified
  `REFERENCES "public"."<table>"(...)`, so relocating the tables via
  `search_path` doesn't relocate the FK targets — `relation
  "public.brokers" does not exist`. Switched to running directly against
  `public` (matching how `test/tenant-live-round-trip.test.ts` already
  works and how CI's throwaway `dirus_test` database is used), with
  explicit `DROP TABLE ... CASCADE` + `DROP OWNED BY`/`DROP ROLE` cleanup
  in `afterAll` for local-rerun idempotency (`DROP ROLE` alone failed with
  "cannot be dropped because some objects depend on it" — residual
  schema-level `GRANT USAGE ON SCHEMA public` needed `DROP OWNED BY` first).

## Workload / PR Boundary (Phase 4)

- Mode: chained PR slice (`feature-branch-chain`)
- Current work unit: Phase 4 — Migrations (fully satisfies `data-model`
  spec's Row Level Security / pgvector Extension / partial-index
  requirements structurally AND against a real live Postgres connection;
  PR 5 in the chain, base = `feat/scaffold-monorepo-ci-workflow`)
- Boundary: starts from the completed schema (Phase 3, no migrations
  existed) and ends with 4 committed migrations, all structurally verified
  and — beyond the literal task list — behaviorally verified against a real
  `pgvector/pgvector:pg17` container. `packages/db/scripts/migrate.ts` (the
  migration runner, Phase 5), root `db:migrate`/`db:generate`/`db:check`
  scripts (5.3), and Phase 6's full live-Neon RLS integration suite are
  explicitly out of scope for this batch, per the hard scope boundary in
  the apply instructions.
- Review budget: `git diff --stat` (both Phase 4 commits combined) excluding
  `pnpm-lock.yaml` and `openspec/` = **16 files changed, 859 insertions(+),
  9 deletions(-)** = **868 changed lines**, human-authored code/tests/SQL
  only. A further **4,434 lines** are drizzle-kit-generated
  `migrations/meta/*_snapshot.json` machine artifacts (1,100 lines × 4,
  near-identical snapshot copies chained by `id`/`prevId` per D-G — not
  meaningfully reviewable line-by-line, same treatment as `pnpm-lock.yaml`).
  Even the 868-line human-authored figure exceeds the 400-line budget by
  ~117% (~2.2x). Not pre-accepted as `size:exception` by the user for this
  specific slice. Flagged as a risk requiring the same kind of decision
  Phase 1/2/3 needed — kept as one PR-chain unit because the migrations are
  mutually dependent in application order (0000 tables → 0001 extension →
  0002 RLS → 0003 grants; RLS policies reference tables that must already
  exist; the drift test needs all four files + journal present
  simultaneously to mean anything), and because the live-verification test
  file, while large (306 lines), is the one piece of evidence this batch's
  instructions treated as non-negotiable — splitting it out alone wouldn't
  reduce total reviewed lines, only fragment the review of a single
  cohesive behavioral proof. **This is a local risk note for whoever turns
  this branch into a PR next** — the same treatment given to Phase 2's
  524-line and Phase 3's 912-line non-pre-accepted overages.

## Judgment Day Round 1 (Phase 4 remediation)

- Confirmed issue (both judges, independently found and empirically
  verified — `relrowsecurity = false`, `relforcerowsecurity = false` on a
  new `broker_id` table read across tenants by `dirus_app`):
  `0003_app_role_grants.sql`'s `ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ... ON TABLES TO dirus_app` auto-grants full CRUD to every table
  created after this migration, with zero coupling to whether that table
  also got RLS. A forgotten `ENABLE`/`FORCE`/`CREATE POLICY` block on a
  future tenant table therefore ships with silent cross-tenant read/write
  access — the grant is automatic, the protection is manual, and the
  failure mode is fail-OPEN.
- Fix, part 1 — catalog-derived guard
  (`packages/db/test/migrations/rls-catalog-guard.test.ts`, new file): a
  live test that queries `pg_class`/`information_schema.columns`/`pg_policies`
  against a real Postgres connection (`LIVE_TEST_DATABASE_URL`) to
  enumerate EVERY table in `public` carrying a `broker_id` column (plus
  `brokers`, keyed on `id`), and asserts each one has
  `relrowsecurity = true`, `relforcerowsecurity = true`, and at least one
  policy whose `USING`/`WITH CHECK` both reference `app.broker_id`. Nothing
  is hardcoded — the table list comes from the live catalog, so it also
  catches a table this file's author never saw.
  - **RED proof**: temporarily added, inside the test's own `beforeAll`
    (after applying 0000/0002 as the owner role), a `CREATE TABLE leads
    (id uuid PRIMARY KEY, broker_id uuid NOT NULL, created_at ...)` with no
    RLS at all — exactly what a forgetful future migration would produce.
    Ran `vitest run test/migrations/rls-catalog-guard.test.ts` against a
    local `pgvector/pgvector:pg17` container: **1 failed | 1 passed (2)**,
    `AssertionError: expected [ 'leads' ] to deeply equal []` — the guard
    named the exact unprotected table.
  - **GREEN proof**: reverted the temporary `leads` table, reran the same
    command: **2 passed (2)** against the current 10 protected tables
    (`brokers` + the 9 `broker_id` tables).
  - Also updated `test/migrations/rls-policies.test.ts`'s
    `BROKER_ID_TABLES` (previously a hand-maintained array, a second source
    of truth) to be derived by parsing `0000_init.sql`'s own `CREATE TABLE`
    blocks for a `broker_id` column, per Judge A's suggestion — that static
    test still can't see a live-only table, which is exactly why the new
    catalog-derived guard exists as a second, live layer.
- Fix, part 2 — decision on the blanket `ALTER DEFAULT PRIVILEGES`: **removed
  it** (`packages/db/migrations/0003_app_role_grants.sql`). Reasoning: the
  existing explicit `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN
  SCHEMA public TO dirus_app` (unchanged, still present) already covers all
  10 currently-existing tables identically — removing default privileges
  has zero effect on today's schema. It only changes the failure mode for
  *future* tables: with the blanket grant gone, a future migration that
  adds a tenant table and forgets both RLS and the explicit re-grant now
  fails LOUD (the app simply cannot read the new table — a visible bug) instead
  of failing OPEN (silent cross-tenant access via an auto-granted default
  privilege). This matches every other design decision already in this
  migration sequence (`FORCE` over `ENABLE`-only, the 2-arg
  `current_setting` form, mandatory `WITH CHECK` alongside `USING`) — the
  codebase's established pattern is fail-closed, and an automatic grant on
  a manually-protected resource is the one place that pattern was inverted.
  The catalog-derived guard (part 1) remains as a second, independent
  compensating control regardless — it protects against a forgotten RLS
  block even on a table where the grant itself was correctly re-added.
- CI wiring: no `.github/workflows/ci.yml` changes were needed or made.
  CI already sets `LIVE_TEST_DATABASE_URL` (deliberately not
  `DATABASE_URL`/`DATABASE_URL_UNPOOLED`) against the `pgvector/pgvector:pg17`
  service container and runs `pnpm -r run test`; the new guard is a
  `describe.skipIf(!liveUrl)` vitest file under `packages/db/test/migrations/`,
  so it runs automatically in every CI run without further wiring — same
  mechanism `live-rls-verification.test.ts` already relies on.
- Incidental fix required by the above: `rls-catalog-guard.test.ts` and
  `live-rls-verification.test.ts` both apply `0000_init.sql`/`0002_rls_policies.sql`
  directly against the same live `public` schema table names (relocating via
  `search_path` doesn't work — 0000's FKs are fully-qualified to `"public"`).
  Vitest runs test files in parallel workers by default, so running both
  files together raced (observed: `rls-catalog-guard.test.ts` reported
  `documents`/`extractions`/`messages` as violations when it actually ran
  concurrently with the other file's `DROP TABLE`/RLS setup). Fixed by
  adding a shared session-level `pg_advisory_lock(478291)` /
  `pg_advisory_unlock(478291)` pair around each file's `beforeAll`/`afterAll`,
  serializing the two without touching either file's fixture logic.
- Full verification after the fix, against a local `pgvector/pgvector:pg17`
  container (`LIVE_TEST_DATABASE_URL` set, so live tests actually ran, not
  skipped): `pnpm --filter @dirus/db exec vitest run` → **15 test files
  passed, 81 tests passed, 0 skipped**. `pnpm -r run typecheck` → all 8
  workspace projects with a `typecheck` script report `Done`, zero errors.
  `pnpm run lint` → clean, no output beyond the eslint invocation.
- Out of scope, confirmed untouched: `provision-app-role.sql` (Phase 6),
  whitespace/malformed-UUID policy handling (covered by `assertUuid`), the
  `-pooler` heuristic, `openspec/ROADMAP.md`, `openspec/PHASES.md`,
  `.atl/*`.

## Judgment Day Round 2 (Phase 4 remediation)

- Confirmed issues 1 & 2 — TWO CRITICALs, found independently by both judges
  and each demonstrated with a live cross-tenant leak against a real
  container while round 1's guard reported GREEN:
  `test/migrations/rls-catalog-guard.test.ts`'s `hasTenantPolicy` check
  verified policy *text*, not policy *behavior*.
  - **Bypass A (decorative predicate)**: `USING (true OR broker_id = ...
    ::uuid)` contains the substring `app.broker_id` in both `qual` and
    `with_check`, so `.includes()` passed it, even though the predicate is
    logically always-true.
  - **Bypass B (extra permissive policy)**: Postgres OR-combines multiple
    PERMISSIVE policies on the same table. A table with the correct
    `tenant_isolation` policy PLUS an unrelated `FOR ALL USING (true)`
    policy is fully open, while `.some()` over `pg_policies` still finds
    the correct policy and reports GREEN.
  - Root cause, one sentence: "a policy mentioning `app.broker_id` exists"
    and "this table is tenant-isolated" are different properties, and no
    amount of string matching bridges them.
- Fix — replaced the per-table string-matching verification with a
  behavioral probe, keeping the catalog-derived *discovery* step (correct,
  not faulted) unchanged. For every catalog-discovered table:
  `introspectTable()` reads `information_schema.columns` /
  `key_column_usage` to find NOT NULL-no-default columns and their FK
  targets (catalog-derived, not hand-maintained); `seedTenantGraph()` seeds
  one row per table for two distinct brokers, in FK-topological order, as
  the `dirus_app`-shaped application role (mirroring
  `live-rls-verification.test.ts`'s established connection pattern); then
  `checkReadIsolation()`/`checkWriteIsolation()` assert broker A's session
  can read ONLY broker A's rows and cannot INSERT a row carrying broker B's
  `broker_id`. A table whose seeding needs (unsupported column type, or a
  required FK outside the discovered tenant-table set) can't be met is
  reported **unverifiable** and fails the suite explicitly — never silently
  counted as verified.
  - False-positive guard (Judge B note, single judge, WARNING, applied):
    `FORCE` + a `SELECT`-only policy denies ALL inserts outright, including
    a same-tenant one — that's safe (fails closed), not proof of isolation,
    and the write probe can't tell the two apart from the outside. When the
    same-tenant "friendly" insert itself is rejected, the probe reports
    `inconclusive-write-denied-outright` (surfaced via `console.warn`, not
    silently folded into pass or fail) instead of guessing.
  - `brokers` is keyed on `id` (the tenant id itself), not `broker_id`, so
    its write probe uses an UPDATE (same-tenant succeeds, cross-tenant
    affects 0 rows) instead of the INSERT-based probe used for the other
    nine tables.
- **STRICT TDD — RED proof, both bypasses, against a live
  `pgvector/pgvector:pg17` container**: two dedicated tests apply each
  bypass to the `policies` table's live policy, run the new probe against
  just that table via a minimal seeded fixture (`policies` + its
  `brokers`/`contacts` dependencies), and assert the probe reports
  `leaked` on both read and write:
  - `RED: catches bypass A — a decorative 'true OR ...' predicate passes
    string matching but leaks` — passed (probe returned `readStatus:
    "leaked"`, `writeStatus: "leaked"` against the `USING (true OR
    broker_id = ...)` policy).
  - `RED: catches bypass B — a correct policy plus an extra permissive FOR
    ALL USING (true) policy leaks via OR-combination` — passed (probe
    returned `readStatus: "leaked"`, `writeStatus: "leaked"` with
    `tenant_isolation` intact plus the extra `support_backdoor` policy
    present).
  - Each test restores the table's original policy state in a `finally`
    block, so the bypass never leaks into later tests.
  - **GREEN proof**: `GREEN: protects every catalog-discovered table via
    behavioral read+write probes, not string matching` — passed against
    the real, unmodified 10 tables (`brokers` + the 9 `broker_id` tables);
    zero leaks, zero unverifiable tables. (One iteration surfaced a
    seeding bug of my own: a constant generated `date` value collided with
    `renewals`'s `UNIQUE(policy_id, due_date)` constraint and masqueraded
    as a write-denied-outright result — fixed by making generated dates
    unique per seed call via a monotonic counter, then reran GREEN clean.)
  - `pnpm --filter @dirus/db exec vitest run test/migrations/rls-catalog-guard.test.ts
    --reporter=verbose` → all 4 tests (discovery, RED × 2, GREEN) passed.
- Confirmed issue 3 — WARNING (real): both `rls-catalog-guard.test.ts` and
  `live-rls-verification.test.ts` had an `afterAll` that ran `dropFixture`,
  then unconditionally the advisory unlock and `admin.end()` — if
  `dropFixture` threw, the unlock never ran, and under `vitest --watch`
  (long-lived process) the session-level lock would stay held and block
  the sibling file's `beforeAll` indefinitely, reintroducing the exact
  deadlock class round 1's lock was added to prevent. Fixed in both files
  by wrapping in `try { dropFixture } finally { unlock; end }`.
- Explicitly out of scope, applied as instructed: no shared
  `withSchemaLock()` helper extracted, no move to schema-per-test-file
  isolation — both noted as debt in the new file's header comment rather
  than implemented, since both judges rated them theoretical rather than
  empirically demonstrated. `.github/workflows/ci.yml` untouched — the
  guard still runs in CI via `LIVE_TEST_DATABASE_URL`, and the new probe
  didn't require any CI wiring change. `openspec/ROADMAP.md`,
  `openspec/PHASES.md`, and `.atl/*` untouched.
- Full verification after all three fixes, against a local
  `pgvector/pgvector:pg17` container (`LIVE_TEST_DATABASE_URL` set, so live
  tests actually ran, not skipped): `pnpm --filter @dirus/db exec vitest
  run` → **15 test files passed, 83 tests passed, 0 skipped** (83 vs round
  1's 81 — the two new RED bypass-demonstration tests). `pnpm -r run
  typecheck` → all 8 workspace projects report `Done`, zero errors.
  `pnpm run lint` → clean (one `no-unused-eslint-disable` warning found and
  fixed — an unnecessary `eslint-disable-next-line no-console` left over
  from drafting, since `no-console` isn't restricted in this repo's config;
  re-ran lint clean after removing it).

## Judgment Day Round 3 (Phase 4 remediation)

Surface: `packages/db/test/migrations/**`. Two confirmed issues, both found
independently by both judges and demonstrated live against a local
`pgvector/pgvector:pg17` container.

- Confirmed issue 1 — CRITICAL: role-scoped policies were invisible to the
  probe. Neither `rls-catalog-guard.test.ts` (probing as `catalog_guard_app`)
  nor `live-rls-verification.test.ts` (probing as `phase4_app`) ever
  connected as, or as anything role-equivalent to, the real production role
  `dirus_app` (`migrations/0003_app_role_grants.sql` /
  `scripts/provision-app-role.sql`). `CREATE POLICY ... TO <role>` only
  applies to a session that satisfies `pg_has_role()` for that literal role
  name, so both judges' `CREATE POLICY prod_backdoor ON policies FOR ALL TO
  dirus_app USING (true) WITH CHECK (true)` was a full cross-tenant leak
  when connected as `dirus_app`, invisible to both suites (reported GREEN).
  There is no live vulnerability today — neither `0002` nor `0003` uses a
  `TO` clause — this is about the guard's compensating-control promise
  against a future regression.
  - Fix (a), fidelity: verified empirically against the live container
    (`GRANT dirus_app TO probe` makes `probe`'s session satisfy
    `pg_has_role(probe, 'dirus_app', 'MEMBER')`, and a role-scoped
    `USING (true)` policy then applies to it — confirmed both directions:
    a member sees the backdoor, a non-member does not) that role
    *membership*, not a literal role name, is what Postgres's RLS role
    check actually tests. Both `APP_ROLE`s (`catalog_guard_app`,
    `phase4_app`) are now granted membership in a role literally named
    `dirus_app`, created in `beforeAll` only if it doesn't already exist
    (and dropped in `afterAll` only if this suite created it — a
    pre-existing `dirus_app` role's login/password is never touched,
    since `provision-app-role.sql` is an explicit one-time production
    step outside migrations). This makes the *existing* behavioral probes
    see a `TO dirus_app` policy the same way `dirus_app` itself would,
    without ever creating/dropping the literal production role name.
  - Fix (b), structural backstop (`rls-catalog-guard.test.ts` only, since
    it's the generalized catalog-derived guard): `assertNoUnexpectedRoleScopedPolicies()`
    reads `pg_policies.roles` directly (via `array_to_string`, since the
    `pg` driver has no built-in parser for the `name[]` array OID and
    returns a raw `"{public}"` string) and fails loud if any
    catalog-discovered table carries a policy scoped to a role outside
    `{public, catalog_guard_app, dirus_app}` — catching a role neither
    behavioral probing nor (a) would ever anticipate. Wired into the
    `GREEN` test before the per-table probe loop.
  - Chose to implement both, not over-engineered: (a) is what actually
    fixes the exact `TO dirus_app` backdoor named in the brief (proven via
    a temporarily-disabled-fix run, see below); (b) is the independent,
    cheap backstop for a role neither the probe nor (a) covers — the two
    are complementary, not redundant.
  - Applied to both files, since both were named as demonstrating the gap:
    `live-rls-verification.test.ts` gets fix (a) plus one dedicated RED
    regression test reproducing the exact backdoor; `rls-catalog-guard.test.ts`
    gets both (a) and (b), plus two new RED tests:
    - `RED: catches bypass C — a policy scoped 'TO dirus_app USING (true)'
      is invisible to a probe not role-equivalent to dirus_app` — proves
      fix (a).
    - `RED: catches bypass D — a policy scoped to an arbitrary
      unvouched-for role is invisible to behavioral probing but caught by
      the pg_policies.roles structural assertion` — proves fix (b) covers
      what (a) structurally cannot (a role neither the probe nor
      `dirus_app` is a member of): the behavioral probe reports
      `isolated` (a false negative on its own), and the structural
      assertion is what actually throws, naming the offending role.
  - **STRICT TDD — RED proof against the live container**: temporarily
    commented out the `GRANT dirus_app TO catalog_guard_app` line (fix (a))
    and reran the new bypass-C test alone:
    `expected 'isolated' to be 'leaked'` — i.e. without the fix, the exact
    judges' backdoor is invisible, reproducing their finding exactly.
    Restored the fix, reran clean (`6 tests passed`).
- Confirmed issue 2 — WARNING (real): nothing prevented the destructive live
  tests (`DROP POLICY` / `CREATE POLICY ... USING (true OR ...)` /
  unqualified `DROP TABLE ... CASCADE`) from running against a real
  database. `finally` restores state on a clean exit but not across a hard
  process kill (Ctrl-C, OOM, or a GitHub Actions `cancel-in-progress`,
  which this repo's workflow enables).
  - Fix: new shared helper
    `packages/db/test/migrations/assert-throwaway-database.ts`, exporting
    `assertThrowawayDatabase(admin)` — queries `current_database()` and
    refuses to proceed unless the name ends in `_test` or `_ci`
    (case-insensitive), or `ALLOW_DESTRUCTIVE_LIVE_TESTS=1` is explicitly
    set, naming the actual refused database in the error. Called first
    thing in `beforeAll`, before any destructive statement, in both
    `rls-catalog-guard.test.ts` and `live-rls-verification.test.ts`.
  - CI wiring check: CI's Postgres service already uses `POSTGRES_DB:
    dirus_test`, which already satisfies the new convention — no
    `.github/workflows/ci.yml` change was needed.
  - **RED proof against the live container**: pointed
    `LIVE_TEST_DATABASE_URL` at a scratch database named `dirus_staging`
    (deliberately not matching the convention) and ran both suites — both
    failed loud in `beforeAll` with `refusing to run destructive live RLS
    tests against database "dirus_staging"...`, before any `DROP`
    statement ran. **GREEN proof**: re-pointed at `dirus_test`, both suites
    passed in full.
- Also applied (SUGGESTION, Judge B): `rls-catalog-guard.test.ts`'s
  `afterAll` now starts with `if (!admin) return;` — if `beforeAll` throws
  before `admin` is assigned (e.g. `assertThrowawayDatabase`'s refusal),
  `afterAll` no longer throws `TypeError: Cannot read properties of
  undefined`, which previously masked the original `beforeAll` failure.
  Confirmed live: the RED proof above (pointed at `dirus_staging`) exercised
  exactly this path — `afterAll` returned cleanly instead of throwing a
  second, confusing error.
- Explicitly out of scope, applied as instructed: no Phase 5/6 work
  started; no shared `withSchemaLock()` helper extracted (the
  throwaway-database guard is a small, genuinely shared utility, not the
  schema-lock helper both judges rated theoretical — kept separate);
  migrations themselves untouched — this round is entirely about the
  guard. `openspec/ROADMAP.md`, `openspec/PHASES.md`, and `.atl/*`
  untouched.
- Full verification, against a local `pgvector/pgvector:pg17` container
  (`LIVE_TEST_DATABASE_URL` set to `dirus_test`, so live tests actually
  ran, not skipped): `pnpm --filter @dirus/db exec vitest run` → **15 test
  files passed, 86 tests passed, 0 skipped** (86 vs round 2's 83 — three
  new tests: two RED bypass-C/D demonstrations plus one RED regression
  test in `live-rls-verification.test.ts`). `pnpm -r run typecheck` → all
  8 workspace projects report `Done`, zero errors. `pnpm run lint` →
  clean, zero warnings.
