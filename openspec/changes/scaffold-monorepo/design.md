# Design: Scaffold the DIRUS monorepo and persistence foundation

## Technical Approach

Schema-first pnpm workspace. Drizzle owns tables/indexes/constraints; RLS policies, the `vector` extension, and app-role grants are hand-written SQL in the same `packages/db/migrations` sequence. The central risk is not the schema — it is that **multi-tenant isolation must survive PgBouncer transaction-mode pooling**. Every decision below is chosen so that a session-scoped tenant setting can never leak onto the next request.

Apps stay empty typed shells (workspace-foundation spec, Scenario "Apps are empty typed shells"). No Hono, no Vite, no Trigger.dev.

## Architecture Decisions

### D-A: Driver — node-postgres (`pg`), not the Neon HTTP driver

| Option | Transactions | Verdict |
|---|---|---|
| `@neondatabase/serverless` HTTP (`neon()`) | **None.** Each query is its own implicit transaction | **Rejected — fatal.** `SET LOCAL` evaporates; `withBrokerContext()` compiles, runs, and silently isolates nothing |
| `@neondatabase/serverless` WebSocket `Pool` | Yes | Rejected — WS proxy complexity buys nothing outside ephemeral serverless |
| **`pg` + `drizzle-orm/node-postgres`** | Yes | **Chosen** |

**Rationale**: ADR-9 deploys a long-lived Node 22 process on a Hetzner VPS. The HTTP driver's only advantage — no TCP handshake per invocation — is worthless for a persistent process, while its lack of transactions is a silent cross-tenant breach. `pg` cannot degrade to non-transactional.

**Enforcement (not a comment)**: `@neondatabase/serverless` is **never added as a dependency**, and a Vitest test in `packages/db` asserts it is absent from `package.json`. A second test proves the round trip: set `app.broker_id` inside a transaction, read it back, commit, then assert it is unset on the next checkout of the same pool.

```ts
export const db = drizzle(new Pool({ connectionString: env.DATABASE_URL }), { schema });
```

### D-B: Two connection URLs

| Var | Endpoint | Used by | Missing / swapped |
|---|---|---|---|
| `DATABASE_URL` | pooled (`...-pooler....neon.tech`) | app runtime client only | Missing → client module throws at import. Host lacking `-pooler` → throws unless `ALLOW_UNPOOLED_RUNTIME=1` |
| `DATABASE_URL_UNPOOLED` | direct | `db:migrate`, `db:push`, `drizzle.config.ts` | Missing → migrate fails fast naming the var (spec: "DATABASE_URL missing at apply time"). Host containing `-pooler` → hard fail before any DDL |

DDL (`CREATE EXTENSION vector`, `CREATE ROLE`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY`) must not cross a transaction pooler. Both documented in `.env.example`; `.env` gitignored.

### D-C: `withBrokerContext` — transaction-scoped, non-bypassable

```ts
export async function withBrokerContext<T>(brokerId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
  assertUuid(brokerId);                       // never interpolate an unvalidated value
  return db.transaction(async (tx) => {
    // SET LOCAL takes no bind parameters; set_config(..., is_local = true) is the parameterized equivalent
    await tx.execute(sql`select set_config('app.broker_id', ${brokerId}, true)`);
    return fn(tx as TenantDb);
  });
}
```

`fn` receives the **scoped tx client** — the only handle callers ever get.

**Structural non-bypassability** (the whole point):
1. The `Pool` and root `db` live in `src/internal/client.ts`, which is **not** reachable: `package.json#exports` publishes only `.` and `./schema`.
2. The public barrel exports `withBrokerContext`, `TenantDb`, and schema — never `db`.
3. Migrations use a separately named `unsafeAdminDb` from `./internal/admin`, unexported from the package root.
4. dependency-cruiser forbids deep imports matching `@dirus/db/(src|dist)/.*`.

```
caller ──withBrokerContext(A, fn)──▶ pool.connect
                                       └─ BEGIN
                                          set_config('app.broker_id','A',true)
                                          fn(tx) ──▶ RLS filters every statement
                                          COMMIT  ─▶ setting discarded with the tx
                                       └─ release to PgBouncer (clean)
```

### D-D: Policy shape — `FOR ALL USING (...) WITH CHECK (...)`

`USING` governs visible/modifiable existing rows; `WITH CHECK` governs written rows. `USING` alone lets broker A **insert a row carrying `broker_id = B`**.

```sql
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policies FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
```

Applied to all nine `broker_id` tables (`brokers` uses `id` as the predicate column).

> **SPEC GAP — surfaced, not patched**: `data-model/spec.md` has no scenario preventing a cross-tenant INSERT. `sdd-tasks` must add: *"GIVEN a transaction with `app.broker_id = A` WHEN it inserts a row with `broker_id = B` THEN the insert is rejected with a row-level-security policy violation."* Do not close this change without it.

### D-E: `current_setting` — the two-argument form is load-bearing

| Form | Unset behavior | Satisfies "zero rows returned"? |
|---|---|---|
| `current_setting('app.broker_id')` | Raises `undefined_object` | No — the query **errors** |
| `current_setting('app.broker_id', true)` | Returns NULL → `broker_id = NULL` is NULL → no row matches | **Yes** |

Both fail closed; only the second matches the written scenario. `nullif(..., '')` guards the one residual hole: a setting explicitly set to `''` would raise on `''::uuid`. `assertUuid` in the helper is the belt to that suspenders.

### D-F: Application role — least privilege, correctly scoped

```sql
CREATE ROLE dirus_app WITH LOGIN PASSWORD :'app_password' NOBYPASSRLS NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO dirus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dirus_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dirus_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dirus_app;
```

**Neon caveat**: roles created through the Neon console are members of `neon_superuser`, which carries `BYPASSRLS`. `dirus_app` MUST be created via SQL so it stays a plain role. No DDL, no ownership.

**Placement**: `CREATE ROLE` is a **documented one-time operational step** (`packages/db/scripts/provision-app-role.sql`, password from env) — it carries secret material and is Neon-account-scoped, so it does not belong in a committed migration. The **grants** live in the migration sequence inside a `DO` block that no-ops when the role is absent, so a fresh clone migrates cleanly.

**Do not overstate**: `FORCE ROW LEVEL SECURITY` already binds the table owner, so RLS functions without this role. `dirus_app` is defense in depth against an accidentally granted `BYPASSRLS` — nothing more.

### D-G: Migration ordering + pre-flight smoke test

| # | File | Kind | Contents |
|---|---|---|---|
| 0000 | `0000_init.sql` | generated | Tables, FKs, UNIQUEs, indexes (partial indexes via Drizzle `.where()`) |
| 0001 | `0001_vector_extension.sql` | custom | `CREATE EXTENSION IF NOT EXISTS vector` (D4: no `doc_chunks`) |
| 0002 | `0002_rls_policies.sql` | custom | ENABLE + FORCE + `FOR ALL USING/WITH CHECK` per table |
| 0003 | `0003_app_role_grants.sql` | custom | `DO` block grants + default privileges |

Hand-written files are created with **`drizzle-kit generate --custom`**, which appends the entry to `meta/_journal.json` without touching the snapshot. Because they contain no Drizzle-modeled DDL, `drizzle-kit check` sees no drift.

`pnpm db:migrate` → `scripts/migrate.ts`, in order: (1) assert `DATABASE_URL_UNPOOLED` present; (2) assert host is not `-pooler`; (3) **connectivity smoke test** — `SELECT 1` with a 5s timeout, failing as `cannot connect to Neon: <host>`; (4) only then run the Drizzle migrator. A bad URL never produces a partially applied migration.

### D-H: Dependency-rule enforcement — dependency-cruiser, run inside Vitest

| Option | Verdict |
|---|---|
| ESLint `no-restricted-imports` | Rejected — per-package globs, drifts as packages are added |
| Hand-rolled import grep test | Rejected — reimplements a resolver, misses type-only and re-exports |
| **dependency-cruiser, asserted in a Vitest test** | **Chosen** — resolver-accurate, reports violating file + import, and runs under `pnpm -r test` |

`.dependency-cruiser.cjs` at root encodes three module rules (`packages/* ↛ apps/*`, `apps/X ↛ apps/Y`, `packages/schemas ↛ workspace`). `packages/config/test/dependency-rule.test.ts` invokes it programmatically and additionally asserts `packages/schemas/package.json` contains no `workspace:*` entry (a manifest fact dependency-cruiser cannot see). Also exposed as `pnpm lint:deps`.

## File Changes

| Path | Action | Description |
|---|---|---|
| `pnpm-workspace.yaml`, root `package.json` | Create | Workspace globs; `db:generate`, `db:migrate`, `db:check`, `lint:deps` |
| `.env.example`, `.gitignore` | Create | Both URLs documented; `.env` ignored |
| `.dependency-cruiser.cjs` | Create | Boundary rules |
| `packages/config/` | Create | Base `tsconfig.json`, flat ESLint config, shared Vitest config, dependency-rule test |
| `packages/db/src/schema/*.ts` | Create | 9 §7.1 tables (no `doc_chunks`) + §7.2 nullable `chatwoot_*` columns |
| `packages/db/src/internal/{client,admin}.ts` | Create | Pool + Drizzle instances, unexported from package root |
| `packages/db/src/tenant.ts`, `src/index.ts` | Create | `withBrokerContext`; barrel exporting only the safe surface |
| `packages/db/migrations/000{0..3}*` | Create | Ordering per D-G |
| `packages/db/scripts/{migrate.ts,provision-app-role.sql}` | Create | Smoke test + migrator; one-time role provisioning |
| `packages/db/README.md` | Create | Two-URL model, role provisioning runbook, RLS invariants |
| `packages/{schemas,agents,integrations}/`, `apps/{api,dashboard,jobs}/` | Create | `package.json` + `tsconfig.json` + typed entrypoint only |

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `assertUuid`; barrel exports no raw client; `@neondatabase/serverless` absent | Vitest, offline |
| Static | Import boundaries, `schemas` manifest | dependency-cruiser under Vitest |
| Migration | Partial indexes keep their `WHERE`; policies use the 2-arg `current_setting` + `WITH CHECK` | Assert on committed SQL text; `drizzle-kit check` |
| Integration (live Neon, app role) | Unset context → zero rows; A cannot read/update/delete B; **A cannot insert as B**; FORCE binds owner; sequential `withBrokerContext` calls on one pooled connection do not leak | Vitest against `DATABASE_URL`, seeded two-broker fixture |

## Migration / Rollout

Greenfield; nothing downstream. Roll back by reverting the commit range and dropping the Neon branch.

## Open Questions

- [ ] `sdd-tasks` MUST add the missing cross-tenant INSERT scenario (D-D).
- [ ] Confirm the Neon project exposes a pooled endpoint; if not, `ALLOW_UNPOOLED_RUNTIME` is the documented interim.
