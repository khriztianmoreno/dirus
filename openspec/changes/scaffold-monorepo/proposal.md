# Proposal: Scaffold the DIRUS monorepo and persistence foundation

## Intent

The repo has documentation and zero code. Every roadmap change (F2, A1, B1) is blocked until the pnpm workspace exists and the §7.1 data model is real, migratable and multi-tenant-safe. Getting `broker_id` + RLS wrong here leaks one broker's book of business into another's, so isolation is designed in now, not retrofitted.

## Scope

### In Scope
- pnpm workspace matching §9: `apps/{api,dashboard,jobs}`, `packages/{agents,db,schemas,integrations,config}` — package manifests + entrypoints only.
- `packages/config`: base tsconfig, lint config, shared Vitest config.
- Vitest as the test runner, wired at root and per package.
- `packages/db`: Drizzle schema for all §7.1 tables (except `doc_chunks`) plus §7.2 `chatwoot_*` nullable columns, the listed indexes, and every UNIQUE constraint carrying idempotency (notably `messages.wa_message_id` and `renewals(policy_id, due_date)`).
- Raw-SQL migration enabling RLS + per-table `broker_id` policies, plus a `withBrokerContext()` transaction helper in `packages/db` that sets `app.broker_id`.
- Initial migration generated with drizzle-kit; `pnpm db:*` scripts.

### Out of Scope
- Application logic: routes, agents, workflows, UI. Apps ship as empty typed shells.
- Zod extraction schemas → `extraction-schemas` (B1).
- Chatwoot deploy and webhook handling → `whatsapp-webhook-ingress` (F2), which also adds the HTTP tenant-resolver middleware and the cross-tenant isolation integration test.
- `infra/` Docker, Caddy, CI → deferred to the F2 deploy slice.
- Scenario B tables (`wa_templates`, `wa_message_events`) — §7.3 is the exit route, not the MVP.

## Capabilities

### New Capabilities
- `workspace-foundation`: workspace topology, dependency rule enforcement, shared tsconfig/lint/test tooling.
- `data-model`: DIRUS persistence schema, idempotency constraints, and multi-tenant isolation (`broker_id` + RLS).

### Modified Capabilities
- None (greenfield).

## Approach

Schema-first. Drizzle owns tables/indexes/constraints; RLS lands as a hand-written SQL migration in the same `packages/db/migrations` sequence, since Drizzle does not model policies.

### Resolved decisions

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Apply migrations to Neon? | **Generate in scope; apply conditional.** `drizzle-kit generate` + committed SQL is the deliverable. If `DATABASE_URL` exists, run `db:migrate` and record it. If not, ship generated SQL + `drizzle-kit check` + a runbook; applying becomes an F2 precondition. | Generation is deterministic and offline; a live Neon project is an unowned external dependency and must not gate the foundation. |
| D2 | RLS now or in F2? | **Now**, policies + `withBrokerContext()`. HTTP wiring in F2. | F2's non-negotiable "tenant X cannot read tenant Y" test needs policies to already exist. Retrofitting RLS onto populated tables is riskier than starting with it. |
| D3 | Turborepo? | **Out.** Use `pnpm -r` with filters. | Zero build graph, zero CI today. Revisit when build time or CI cache actually costs something. |
| D4 | pgvector? | **Extension in, `doc_chunks` table out.** | `CREATE EXTENSION vector` is one reversible line that proves Neon support early. The table's `vector(768)` locks an embedding dimension to a Phase C model choice not yet made. |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `pnpm-workspace.yaml`, root `package.json` | New | Workspace + `db:*` scripts |
| `packages/config` | New | tsconfig / lint / vitest base |
| `packages/db` | New | Drizzle schema, RLS migration, client, tenant helper |
| `packages/{schemas,agents,integrations}`, `apps/{api,dashboard,jobs}` | New | Empty typed shells |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| No `DATABASE_URL` available | High | D1 fallback: generated SQL + `drizzle-kit check`, apply deferred |
| RLS policies block all reads because `app.broker_id` is unset | Med | All DB access goes through `withBrokerContext()`; test asserting an unset context returns zero rows |
| RLS silently bypassed by a superuser/owner Neon role | Med | Use `FORCE ROW LEVEL SECURITY` and a non-owner app role; documented in the db README |
| Schema drift vs. `docs/ARCHITECTURE.md` §7.1 | Med | Table-by-table checklist in tasks; §7.1 is the reviewer's diff reference |

## Rollback Plan

Nothing depends on this change yet. Revert the commit range — the repo returns to docs-only. If migrations were applied to Neon, drop the branch/database; no production data exists and nothing downstream references the migration numbering.

## Dependencies

- None blocking. Optional: a Neon project + `DATABASE_URL` to exercise D1's apply path.

## Success Criteria

- [ ] `pnpm install` succeeds from a clean clone; `pnpm -r typecheck` and `pnpm -r test` pass.
- [ ] Every §7.1 table (minus `doc_chunks`) plus §7.2 `chatwoot_*` columns exists in the Drizzle schema, with all listed indexes and UNIQUE constraints.
- [ ] Initial migration SQL is generated, committed, and `drizzle-kit check` reports no drift.
- [ ] RLS is enabled and forced on every `broker_id` table; a test proves reads return nothing without `app.broker_id`.
- [ ] Dependency rule holds: no `packages/*` imports an app, no app imports another app, `packages/schemas` has no workspace deps.
