# Apply Progress: Scaffold the DIRUS monorepo and persistence foundation

**Mode**: Strict TDD throughout. Phase 1: RED/GREEN applied to tasks 1.4/1.5
and the schemas zero-workspace-deps assertion added under 1.8; tasks 1.1-1.3
and 1.6-1.8 are structural scaffolding — package.json/tsconfig/typed-entrypoint
files with no branching logic — verified via `pnpm -r typecheck` and
`pnpm -r test` per task 1.9 rather than synthetic unit tests. Phase 2: full
RED/GREEN/REFACTOR cycle on every task (2.1-2.9); a RED-verified regression
test (2.2) plus one extra live-round-trip test (2.10, added beyond the literal
task list per design.md D-A) are blocked/skipped pending a real Postgres
connection.

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
- Current branch: `feat/scaffold-monorepo-db-driver-tenant-guards`
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
