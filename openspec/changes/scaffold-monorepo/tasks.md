# Tasks: Scaffold the DIRUS monorepo and persistence foundation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1400-1900 (workspace configs, 9 Drizzle tables, 4 migrations, driver/tenant guards, ~15 test files, docs) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (workspace) -> PR 2 (db driver/schema/migrations) -> PR 3 (RLS integration + docs) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — user decision needed |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Workspace topology, `packages/config`, dependency-cruiser rule, empty typed shells | PR 1 | Base = main (or tracker branch if feature-branch-chain chosen). Fully satisfies `workspace-foundation` spec. |
| 2 | `packages/db` driver (D-A/D-B), schema (§7.1/§7.2), `withBrokerContext` (D-C/D-E), migrations 0000-0003 (D-G), static/unit tests | PR 2 | Base = PR 1 branch. Depends on Unit 1's `packages/config`. |
| 3 | Live-Neon RLS integration tests (incl. cross-tenant INSERT, D-D), app-role provisioning runbook, `packages/db/README.md`, `db:migrate` live run | PR 3 | Base = PR 2 branch. Non-startable until `DATABASE_URL`/`DATABASE_URL_UNPOOLED` exist (external precondition, per config.yaml). |

Ask the user for chain strategy (stacked-to-main / feature-branch-chain / size-exception) before `sdd-apply` starts Unit 2.

## Phase 1: Workspace Foundation (workspace-foundation)

- [x] 1.1 Create `pnpm-workspace.yaml` with the 8 packages; root `package.json` with `-r` scripts.
- [x] 1.2 Create `.gitignore` (`.env`, `node_modules`, `dist`) and `.env.example` documenting `DATABASE_URL` + `DATABASE_URL_UNPOOLED`.
- [x] 1.3 Create `packages/config`: base `tsconfig.json`, flat ESLint config, shared Vitest config.
- [x] 1.4 RED: `packages/config/test/dependency-rule.test.ts` — asserts no `packages/* -> apps/*`, no app-to-app import, `packages/schemas` has zero `workspace:*` deps (workspace-foundation: Dependency Rule Enforcement).
- [x] 1.5 GREEN: `.dependency-cruiser.cjs` with the three boundary rules; wire test to invoke it programmatically; add `pnpm lint:deps`.
- [x] 1.6 Create `apps/{api,dashboard,jobs}`: `package.json` + `tsconfig.json` extending `packages/config` + minimal compiling entrypoint, no server/route/Vite/Trigger.dev wiring (workspace-foundation: Apps are empty typed shells).
- [x] 1.7 Create `packages/{agents,integrations}`: `package.json` + `tsconfig.json` + typed entrypoint.
- [x] 1.8 Create `packages/schemas`: `package.json` (zero workspace deps) + `tsconfig.json` + entrypoint.
- [x] 1.9 Verify `pnpm install` succeeds clean; `pnpm -r typecheck` and `pnpm -r test` run (workspace-foundation: Root-Level Verification Commands).

## Phase 2: DB Driver & Tenant Guards (data-model, design D-A/D-B/D-C/D-E)

- [x] 2.1 Create `packages/db/package.json` (deps: `pg`, `drizzle-orm`, `drizzle-kit`; never `@neondatabase/serverless`).
- [x] 2.2 RED: test asserting `@neondatabase/serverless` absent from `packages/db/package.json` (D-A enforcement).
- [x] 2.3 RED: test — client throws when `DATABASE_URL` missing; throws on non-`-pooler` host unless `ALLOW_UNPOOLED_RUNTIME=1` (D-B).
- [x] 2.4 GREEN: `packages/db/src/internal/client.ts` — `Pool` + `drizzle(node-postgres)`, host/env guards; `src/internal/admin.ts` (`unsafeAdminDb`, unexported).
- [x] 2.5 RED: test — package `exports` map publishes only `.` and `./schema`; barrel never exports raw `db`.
- [x] 2.6 GREEN: `packages/db/src/index.ts` barrel (schema, `withBrokerContext`, `TenantDb`) + `package.json#exports` restriction.
- [x] 2.7 RED: `assertUuid` rejects malformed input.
- [x] 2.8 RED: `withBrokerContext` two sequential calls (different broker IDs, same pool) never leak the prior setting (data-model: Helper scopes broker_id to the transaction only).
- [x] 2.9 GREEN: `packages/db/src/tenant.ts` — `withBrokerContext` using `set_config('app.broker_id', $1, true)` inside `tx`, `assertUuid` guard.
- [x] 2.10 (added beyond literal task list, per design.md D-A's explicit test requirement) Live round-trip test: set `app.broker_id` in a transaction, read it back, commit, assert unset on the next checkout of the same pool. **Blocked/skipped** in this environment — no live Postgres reachable; gated behind `LIVE_TEST_DATABASE_URL`.

## Phase 3: Schema (data-model)

- [x] 3.1 RED: schema test — every §7.1 table/column/type/default/FK matches `docs/ARCHITECTURE.md` §7.1 (table-by-table checklist).
- [x] 3.2 RED: test — no `doc_chunks` table defined.
- [x] 3.3 RED: test — `chatwoot_*` nullable columns insert without value successfully. (Interpreted structurally as "no NOT NULL constraint" — no live Postgres/generated migration available this phase; see apply-progress Phase 3 notes.)
- [x] 3.4 RED: test — UNIQUE constraints exist for `messages.wa_message_id`, `renewals(policy_id, due_date)`, `contacts(broker_id, phone)`, `broker_users(broker_id, phone)`, `brokers.wa_phone_number_id`.
- [x] 3.5 GREEN: `packages/db/src/schema/{brokers,broker_users,contacts,conversations,messages,policies,documents,extractions,renewals}.ts` with columns, FKs, indexes (incl. two partial indexes), chatwoot columns, unique constraints.

## Phase 4: Migrations (design D-D/D-F/D-G)

- [x] 4.1 Run `drizzle-kit generate` -> commit `0000_init.sql`.
- [x] 4.2 RED: static-SQL test — partial index `WHERE` clauses present verbatim on `policies`/`extractions`.
- [x] 4.3 `drizzle-kit generate --custom` -> `0001_vector_extension.sql` (`CREATE EXTENSION IF NOT EXISTS vector`); RED/GREEN test asserting extension statement present, no `vector(...)` column anywhere.
- [x] 4.4 RED: static-SQL test — spec-gap scenario from D-D: transaction with `app.broker_id=A` inserting `broker_id=B` must be rejected (assert `WITH CHECK` clause present per policy, not `USING`-only).
- [x] 4.5 GREEN: `0002_rls_policies.sql` — `ENABLE`+`FORCE ROW LEVEL SECURITY`, `FOR ALL USING/WITH CHECK` with 2-arg `current_setting` + `nullif` on all 9 `broker_id` tables (`brokers` keyed on `id`).
- [x] 4.6 GREEN: `0003_app_role_grants.sql` — `DO` block granting `dirus_app` (no-op if role absent).
- [x] 4.7 Create `packages/db/scripts/provision-app-role.sql` (documented one-time step, password from env, `NOBYPASSRLS NOSUPERUSER`).
- [x] 4.8 RED: test — `drizzle-kit check` reports zero drift.

## Phase 5: Migration Runner (design D-G)

- [ ] 5.1 RED: unit tests for extracted guard functions — missing `DATABASE_URL_UNPOOLED` fails fast naming the var; `-pooler` host in unpooled URL fails before DDL.
- [ ] 5.2 GREEN: `packages/db/scripts/migrate.ts` — order: assert unpooled URL present -> assert non-pooled host -> 5s `SELECT 1` smoke test -> run Drizzle migrator.
- [ ] 5.3 Add root `db:generate`, `db:migrate`, `db:check` scripts.
- [ ] 5.4 If `DATABASE_URL` exists in this environment: run `pnpm db:migrate`, record result; else document as deferred per proposal D1 (non-startable until a Neon project exists).

## Phase 6: Live RLS Integration (data-model, blocked on external Neon precondition)

- [ ] 6.1 Seed two-broker fixture against live Neon (app role connection).
- [ ] 6.2 Test: unset `app.broker_id` -> zero rows (data-model: Unset broker context).
- [ ] 6.3 Test: A cannot read B's rows across `policies`/`contacts`/`messages`.
- [ ] 6.4 Test: A cannot UPDATE/DELETE B's row by PK (zero rows affected).
- [ ] 6.5 Test: A cannot INSERT a row with `broker_id=B` (D-D cross-tenant insert rejection — RLS violation).
- [ ] 6.6 Test: table-owner role without `app.broker_id` set -> zero rows (`FORCE` binds owner).
- [ ] 6.7 Run `provision-app-role.sql` against target Neon project; verify role lacks `BYPASSRLS`.

## Phase 7: Documentation & Final Verification

- [ ] 7.1 Write `packages/db/README.md`: two-URL model, role provisioning runbook, RLS invariants.
- [ ] 7.2 Cross-check every proposal Success Criteria checkbox against completed tasks.
- [ ] 7.3 Run `pnpm install`, `pnpm -r typecheck`, `pnpm -r test` from a clean clone; confirm all pass.
