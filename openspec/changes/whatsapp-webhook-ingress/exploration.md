# Exploration — `whatsapp-webhook-ingress` (F2)

Findings from the exploration phase. Input to `proposal.md`; not a decision record.

## 1. No migration is required for the stated hard requirements

Every table and constraint the ROADMAP's hard requirements name already exists
(`packages/db/src/schema/*.ts`, `packages/db/migrations/0000_init.sql`):

| Object | Definition | Role in F2 |
|---|---|---|
| `brokers.wa_phone_number_id` | `text NOT NULL UNIQUE` | tenant-resolution key |
| `messages.wa_message_id` | `text UNIQUE` (nullable) | dedup key |
| `messages.broker_id` | `uuid NOT NULL REFERENCES brokers(id)` | tenant column |
| `messages.conversation_id` | `uuid NOT NULL REFERENCES conversations(id)` | see §4 |
| `contacts` | `UNIQUE (broker_id, phone)` | upsert key for a new sender |
| `conversations` | `broker_id`, `contact_id` (nullable), `status` default `'bot'` | see §4 |

F2 is a code-only change against the existing schema — **unless** the RLS
question in §3 forces a new policy/grant migration, which it very likely does.

## 2. What `packages/db` exposes to `apps/api`

`packages/db/src/index.ts` plus `package.json#exports` (restricted to `"."` and
`"./schema"`) mean `apps/api` may import exactly:

- `withBrokerContext(brokerId, fn)` — opens a transaction, runs
  `select set_config('app.broker_id', $1, true)`, hands the callback a scoped
  `tx`. Guarded against reentrancy by an `AsyncLocalStorage`.
- `assertUuid`, the `TenantDb` type, and `schema`.

It may **not** reach the raw pooled client or `unsafeAdminDb`; both live under
`src/internal/` and are unreachable through Node's own resolution, not merely
by lint convention.

The `pg` (node-postgres) driver is mandatory. The Neon HTTP serverless driver
has no transactions, so `set_config(..., true)` would silently no-op and the
tenant scope would evaporate — which is precisely why ingress code must go
through `withBrokerContext` and never a one-shot query client.

## 3. The central tension: resolving a tenant before tenant context exists

`packages/db/migrations/0002_rls_policies.sql`:

```sql
ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;
ALTER TABLE brokers FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON brokers FOR ALL
  USING      (id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.broker_id', true), '')::uuid);
```

A webhook arrives carrying a `wa_phone_number_id` and no tenant identity.
Discovering which broker owns it is itself a read of `brokers` — and it must
run **before** any `broker_id` is known, therefore before `withBrokerContext`
can be called. With `app.broker_id` unset, `current_setting(..., true)` returns
`NULL`, `id = NULL` matches nothing, and the lookup fails closed to zero rows.

Fails closed is the correct default (design.md D-E). But it means **there is
currently no code path in `packages/db` capable of performing this lookup at
all.**

### Why the obvious escapes do not work

`FORCE ROW LEVEL SECURITY` binds the table-owning role as well. This is not an
inference — `packages/db/test/migrations/live-rls-verification.test.ts` proves
it with a negative control, asserting the owner sees zero rows with FORCE and
non-zero once FORCE is removed.

Consequently:

- A `SECURITY DEFINER` function **owned by the table owner** is still bound by
  FORCE and still returns zero rows.
- A non-`security_invoker` view owned by the table owner: same.
- A permissive `CREATE POLICY ... FOR SELECT USING (true)` granted to
  `dirus_app` does work, but policies for the same command combine with `OR`.
  It would make every `brokers` row readable to the application role on every
  query. Column-level `GRANT`s narrow which columns come back; they do not
  restore the row filter. This reopens the hole FORCE was added to close.
- `unsafeAdminDb` is rejected outright: it is documented as migrations/DDL
  only, requires a direct non-PgBouncer connection unsuited to hot-path
  request traffic, and is unexported specifically so application code cannot
  reach it.

### The shape that survives

RLS policies are role-scoped through the `TO` clause. A dedicated role, a
policy only that role satisfies, and a `SECURITY DEFINER` function owned by
that role with `EXECUTE` granted to `dirus_app`, returning a single `uuid` and
no table access, keeps the permissive read off `dirus_app` entirely.

This is a hypothesis for `sdd-design` to evaluate and prove, **not a decision**.
It must be settled with an explicit design entry and a live test before any
implementation, because a design that gets this wrong cannot pass its own
non-negotiable isolation test.

Whichever mechanism wins, `packages/db`'s public barrel gains a new exported
function that runs *outside* `withBrokerContext` — a new class of access the
current `tenant.ts` docstring does not account for ("`TenantDb` ... is the only
tenant-scoped handle callers ever receive").

## 4. Schema-imposed steps the ROADMAP's scope line omits

`messages.conversation_id` is `NOT NULL`. Persisting an inbound message
therefore requires a `conversations` row, and in practice a `contacts` row for
a first-time sender (`UNIQUE (broker_id, phone)`). The ROADMAP's one-line scope
— resolve tenant, dedup, persist, echo — does not mention the conversation and
contact upsert steps the schema actually demands. The proposal must state them.

## 5. `apps/api` is genuinely empty

```ts
export const APP_NAME = "@dirus/api" as const;
```

`dependencies: {}`; only `@dirus/config` as a devDependency. This change must
add the HTTP framework (`hono`, per `docs/ARCHITECTURE.md` and
`openspec/project.md`), the route layout that document already specifies
(`src/routes/webhooks/`, `src/routes/health`, `src/middleware/tenant-resolver`),
and env loading — `packages/config` carries no env utility, so `apps/api` needs
its own, ideally mirroring the fail-loud-at-startup pattern in
`packages/db/src/internal/client.ts`.

No Chatwoot/WhatsApp webhook payload schema exists in `packages/schemas` yet.

## 6. Test conventions to follow, not reinvent

`packages/db/test/migrations/live-rls-verification.test.ts` is the pattern:
gated on `LIVE_TEST_DATABASE_URL` via `describe.skipIf`, run against a
throwaway schema with disposable fixture roles, guarded by
`assertThrowawayDatabase` before any destructive statement. CI provides a
`pgvector/pgvector:pg17` service container.

The existing two-broker fixture covers `contacts` and `policies` isolation.
It does **not** cover `messages`, nor the brokers-lookup mechanism §3 will
introduce. The ROADMAP's non-negotiable test is therefore new work.

## 7. Open questions for the proposal

1. Which mechanism resolves §3? Requires its own `design.md` entry.
2. Is webhook signature verification in scope? `docs/ARCHITECTURE.md` §11
   requires it on all inbound webhooks; the ROADMAP's F2 line omits it. Close
   the gap explicitly or defer it with justification — do not leave it unstated.
3. What is Chatwoot's actual outbound webhook JSON shape, and does its schema
   belong in `packages/schemas` or inline in `apps/api`?
4. Should the ROADMAP's F2 scope line be corrected? It still reads "Chatwoot
   deployed on the VPS", which this change explicitly excludes as an
   infrastructure workstream.
