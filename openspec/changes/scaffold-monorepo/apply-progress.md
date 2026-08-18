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
(same constraint as Phase 2's 2.10).

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
- Current branch: `feat/scaffold-monorepo-schema-tables`
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
