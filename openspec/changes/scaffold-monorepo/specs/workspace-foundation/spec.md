# Workspace Foundation Specification

## Purpose

Establish the pnpm monorepo topology, shared tooling, and an enforceable import boundary so future changes (F2, A1, B1) build on a consistent, typed, testable workspace.

## Requirements

### Requirement: Workspace Topology

The system MUST define a pnpm workspace with exactly these packages: `apps/api`, `apps/dashboard`, `apps/jobs`, `packages/agents`, `packages/db`, `packages/schemas`, `packages/integrations`, `packages/config`.

#### Scenario: Clean install succeeds

- GIVEN a clean clone of the repository with no `node_modules`
- WHEN `pnpm install` runs at the repo root
- THEN all eight packages resolve their workspace dependencies without error

#### Scenario: Apps are empty typed shells

- GIVEN `apps/api`, `apps/dashboard`, `apps/jobs`
- WHEN their contents are inspected
- THEN each contains only `package.json`, `tsconfig.json`, and a minimal entrypoint file that compiles
- AND none contains a Hono server, `/health` route, Vite app wiring, or Trigger.dev task/config (deferred to F2)

### Requirement: Dependency Rule Enforcement

The system MUST enforce that `apps/*` may import from `packages/*`, `packages/*` MUST NOT import from any app, no app MUST import another app, and `packages/schemas` MUST have zero workspace dependencies. This rule MUST be machine-checked, not documented only.

#### Scenario: Lint or test catches a forbidden import

- GIVEN a package under `packages/*` with an import statement referencing `apps/*`
- WHEN the enforcement check (lint rule or dedicated test) runs
- THEN it fails with an error identifying the violating file and import

#### Scenario: schemas package has no workspace deps

- GIVEN `packages/schemas/package.json`
- WHEN its `dependencies` and `devDependencies` are inspected
- THEN no entry references another workspace package (`workspace:*`)

#### Scenario: Compliant workspace passes

- GIVEN the scaffolded workspace with no violations
- WHEN the enforcement check runs
- THEN it exits with zero errors

### Requirement: Shared Tooling via packages/config

The system MUST provide `packages/config` exposing a base `tsconfig.json`, a shared lint configuration, and a shared Vitest configuration that other packages extend.

#### Scenario: A package extends the base config

- GIVEN `packages/db/tsconfig.json`
- WHEN it is inspected
- THEN it extends the base config exported by `packages/config`

### Requirement: Root-Level Verification Commands

The system MUST support `pnpm -r typecheck` and `pnpm -r test` as root commands that recurse into every package, and both MUST pass from a clean clone.

#### Scenario: Typecheck passes across the workspace

- GIVEN a freshly installed workspace
- WHEN `pnpm -r typecheck` runs
- THEN every package reports zero type errors

#### Scenario: Test suite passes across the workspace

- GIVEN a freshly installed workspace with Vitest wired at root and per package
- WHEN `pnpm -r test` runs
- THEN every package's test suite exits successfully, including at least one dependency-rule test and the `packages/db` RLS/idempotency tests
