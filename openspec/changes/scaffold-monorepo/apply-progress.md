# Apply Progress: Scaffold the DIRUS monorepo and persistence foundation

**Mode**: Strict TDD (RED/GREEN applied to tasks 1.4/1.5 and the schemas
zero-workspace-deps assertion added under 1.8; tasks 1.1-1.3 and 1.6-1.8 are
structural scaffolding — package.json/tsconfig/typed-entrypoint files with no
branching logic — verified via `pnpm -r typecheck` and `pnpm -r test` per
task 1.9 rather than synthetic unit tests).

## Chain / Branch Topology

- Chain strategy: `feature-branch-chain` (user-selected)
- Tracker branch: `feat/scaffold-monorepo` → points at baseline commit
  `0ab46f3` (pre-existing planning artifacts only; untouched by this batch)
- PR 1 / Unit 1 branch: `feat/scaffold-monorepo-workspace-foundation`
  (base = tracker branch)
- Current branch: `feat/scaffold-monorepo-workspace-foundation`
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
