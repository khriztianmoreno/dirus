# Data Model Specification

## Purpose

Define the DIRUS persistence schema (§7.1/§7.2 of `docs/ARCHITECTURE.md`), its idempotency constraints, multi-tenant isolation via Postgres Row Level Security, and the tenant-resolution mechanism required to bootstrap broker context before any tenant-scoped query can run. This spec is the union of F1 (`scaffold-monorepo`) foundational requirements and F2 (`whatsapp-webhook-ingress`) delta requirements for the resolver role/policy/function.

## Requirements

### Requirement: Core Schema Tables

The system MUST define, via Drizzle, every §7.1 table except `doc_chunks`: `brokers`, `broker_users`, `contacts`, `conversations`, `messages`, `policies`, `documents`, `extractions`, `renewals` — with all columns, types, defaults, and foreign keys as specified in §7.1.

#### Scenario: Schema matches §7.1 column-for-column

- GIVEN the Drizzle schema in `packages/db`
- WHEN each table is compared against §7.1 of `docs/ARCHITECTURE.md`
- THEN every column, type, default, and FK reference matches exactly

#### Scenario: doc_chunks and pgvector table are excluded

- GIVEN `packages/db` schema files
- WHEN searched for a `doc_chunks` table definition
- THEN none exists (D4: table deferred to Phase C)

### Requirement: Chatwoot Mirror Columns

The system MUST add the §7.2 nullable `chatwoot_*` columns: `brokers.chatwoot_account_id` (integer, UNIQUE), `contacts.chatwoot_contact_id`, `conversations.chatwoot_conversation_id`, `messages.chatwoot_message_id` (all integer, nullable, no other constraint).

#### Scenario: Chatwoot columns are nullable

- GIVEN a row inserted into `brokers`, `contacts`, `conversations`, or `messages` without a `chatwoot_*` value
- WHEN the insert runs
- THEN it succeeds

### Requirement: Required Indexes

The system MUST create every index listed in §7.1, including the two partial indexes: `CREATE INDEX ON policies (broker_id, end_date) WHERE status = 'active'` and `CREATE INDEX ON extractions (broker_id, needs_review) WHERE needs_review = true`, plus `CREATE INDEX ON messages (conversation_id, created_at)`.

#### Scenario: Partial indexes exist and are partial

- GIVEN the committed migration SQL
- WHEN inspected for the `policies` and `extractions` indexes
- THEN both include their `WHERE` clause verbatim (not full-table indexes)

### Requirement: Idempotency Constraints

The system MUST enforce these UNIQUE constraints, each preventing a specific real-world duplication: `messages.wa_message_id` (Meta/Chatwoot webhook replay dedup), `renewals(policy_id, due_date)` (renewal cron re-run dedup), `contacts(broker_id, phone)`, `broker_users(broker_id, phone)`, `brokers.wa_phone_number_id` (WhatsApp/Chatwoot mirror column — no longer the tenant-resolution key; see "Tenant Resolution by account.id" and `brokers.chatwoot_account_id`'s own uniqueness below), `brokers.chatwoot_account_id` (tenant resolution per webhook, since `fix-chatwoot-tenant-resolution`/F2.1).

#### Scenario: Duplicate wa_message_id is rejected

- GIVEN a message row already exists with `wa_message_id = 'wamid.X'`
- WHEN a second insert attempts the same `wa_message_id`
- THEN the database rejects it with a unique-violation error

#### Scenario: Duplicate renewal for the same due date is rejected

- GIVEN a renewal row exists for `(policy_id = P, due_date = D)`
- WHEN a second insert attempts the same `(policy_id, due_date)` pair
- THEN the database rejects it with a unique-violation error

### Requirement: pgvector Extension Enabled

The system MUST run `CREATE EXTENSION IF NOT EXISTS vector` as part of the migration set, without creating any table that uses the `vector` type.

#### Scenario: Extension is present, no vector table exists

- GIVEN the applied Neon database
- WHEN `SELECT * FROM pg_extension WHERE extname = 'vector'` runs
- THEN it returns one row, and no table in the schema declares a `vector(...)` column

### Requirement: Row Level Security Enforced and Forced

Every table carrying `broker_id` MUST have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, with a policy restricting rows to `broker_id = current_setting('app.broker_id')::uuid`. `FORCE` extends policy enforcement to the table owner; it does not exempt the owner. Superusers and roles with `BYPASSRLS` remain outside policy enforcement regardless of `FORCE`. A dedicated non-owner, non-`BYPASSRLS` application role MUST be used by the app connection as defense in depth against an accidentally granted bypass.

#### Scenario: Unset broker context returns zero rows

- GIVEN a live Neon connection using the application role, with `app.broker_id` never set in the session
- WHEN `SELECT * FROM policies` runs
- THEN zero rows are returned, even though rows exist for multiple brokers

#### Scenario: Broker A cannot read Broker B's rows

- GIVEN two brokers A and B each with rows in `policies`, `contacts`, and `messages`
- WHEN a transaction sets `app.broker_id = A` and queries any of those three tables
- THEN only rows belonging to broker A are returned

#### Scenario: Broker A cannot update or delete Broker B's rows

- GIVEN broker B owns a row in `policies`
- WHEN a transaction with `app.broker_id = A` attempts `UPDATE` or `DELETE` on that row by primary key
- THEN zero rows are affected

#### Scenario: FORCE applies to the table owner

- GIVEN the migration is applied by the table-owning role (not the app role, not a superuser/BYPASSRLS role)
- WHEN that owner role queries a `broker_id` table without setting `app.broker_id`
- THEN zero rows are returned, proving `FORCE ROW LEVEL SECURITY` is active

#### Scenario: Cross-tenant INSERT is blocked by WITH CHECK

- GIVEN two brokers A and B exist
- WHEN a transaction with `app.broker_id = A` attempts `INSERT INTO policies (broker_id, ...) VALUES (B, ...)`
- THEN zero rows are affected and the constraint violation is raised (or silently rejected), proving the `WITH CHECK` clause on the policy guards INSERT

### Requirement: withBrokerContext Transaction Helper

`packages/db` MUST export a `withBrokerContext(brokerId, fn)` helper that opens a transaction, sets `app.broker_id` for that transaction's scope via `SET LOCAL`, executes `fn`, and commits or rolls back atomically.

#### Scenario: Helper scopes broker_id to the transaction only

- GIVEN two sequential calls to `withBrokerContext` with different broker IDs on the same pooled connection
- WHEN each call runs its query
- THEN each sees only its own broker's rows, with no leakage from the prior call's setting

### Requirement: Live Migration Applied to Neon

Given `DATABASE_URL` is available via a gitignored root `.env`, the system MUST run `db:migrate` against the live Neon database and verify RLS behavior against that live database, not only against generated SQL.

#### Scenario: Migration applies cleanly

- GIVEN a Neon database reachable via `DATABASE_URL`
- WHEN `pnpm db:migrate` runs
- THEN it completes without error and all tables, indexes, constraints, and RLS policies exist in Neon

#### Scenario: drizzle-kit reports no drift

- GIVEN the committed migration files and the Drizzle schema
- WHEN `drizzle-kit check` runs
- THEN it reports no drift between schema and migrations

#### Scenario: DATABASE_URL missing at apply time

- GIVEN `DATABASE_URL` is not set in the environment
- WHEN `pnpm db:migrate` is invoked
- THEN it fails fast with a clear error naming the missing variable, and does not silently skip

## Delta: Tenant Resolver Role (F2 Extension)

The following requirements extend the base data-model capability with the tenant-resolution mechanism required before any tenant-scoped query can run. F2 needs a request holding only a `wa_phone_number_id` to learn its `broker_id` — but the existing `brokers` policy requires `app.broker_id` to already be set. This delta specifies the invariants `packages/db/migrations/0004_tenant_resolver.sql` must satisfy.

### Requirement: Dedicated Tenant Resolver Role Exists and Cannot Log In

The system MUST define a role, `dirus_tenant_resolver`, that is `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, and `NOCREATEROLE`. This role is a privilege container a `SECURITY DEFINER` function assumes for the duration of its body — it is never a connection identity, and no application code or human ever authenticates as it directly.

#### Scenario: Resolver role exists and cannot establish a session

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `pg_roles` is queried for `rolname = 'dirus_tenant_resolver'`
- THEN exactly one row is returned with `rolcanlogin = false`, `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, and `rolcreaterole = false`

#### Scenario: Direct connection as the resolver role is refused

- GIVEN the resolver role exists
- WHEN a client attempts to open a database session authenticating as `dirus_tenant_resolver`
- THEN Postgres refuses the connection (`NOLOGIN` role)

### Requirement: The Permissive brokers Lookup Policy Is Scoped to the Resolver Role Only

The system MUST add a permissive `SELECT` policy on `brokers`, `tenant_resolver_lookup`, whose `TO` clause names only `dirus_tenant_resolver`. This policy is additional to, and does not modify, the existing `tenant_isolation` policy, which continues to govern every role not matching `tenant_resolver_lookup`'s `TO` clause — most importantly `dirus_app`. Because Postgres combines multiple permissive policies for the same command with `OR`, any role for which both policies apply would see the union of both — this is precisely what must not happen for `dirus_app`.
(Previously: the negative-control scenario called `dirus_resolve_broker_id('phoneA')`, a text-keyed lookup; migration `0007` replaces it with an integer-keyed call. No other change.)

#### Scenario: The permissive lookup policy names only the resolver role

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_policies` (or `pg_policy` joined to `pg_roles`) is queried for the policy `tenant_resolver_lookup` on `brokers`
- THEN its `roles` array contains exactly `{dirus_tenant_resolver}` and no other role, including `dirus_app` and the table owner

#### Scenario: dirus_app in a session that just resolved a broker still sees zero brokers rows directly (negative control)

- GIVEN a live database with the base migrations and `0007` applied, with at least one `brokers` row existing at a known `chatwoot_account_id = 555001`
- WHEN, in a single session authenticated as `dirus_app` with no `app.broker_id` ever set, `SELECT dirus_resolve_broker_id(555001)` is called and successfully returns a broker id, and immediately afterward, in that same session, `SELECT * FROM brokers` and `SELECT count(*) FROM brokers` are run
- THEN both queries return zero rows — a successful resolver call MUST NOT leave the session able to read `brokers` directly; if either query returns anything non-zero, the design is wrong

#### Scenario: tenant_isolation on brokers is unchanged by this migration

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_policies` is queried for all policies on `brokers`
- THEN the `tenant_isolation` policy from the base migration still exists with its original `USING`/`WITH CHECK` predicate and its original `TO` scope, and exactly one additional policy (`tenant_resolver_lookup`) is present

### Requirement: The Resolver Function Is SECURITY DEFINER, Owned by the Resolver Role, Takes an Integer Key, Returns a Bare uuid, and Has a Pinned search_path

The system MUST define `public.dirus_resolve_broker_id(p_key integer) RETURNS uuid` as `SECURITY DEFINER`, owned by `dirus_tenant_resolver`, taking the resolution key as a bound integer parameter (never string-interpolated, never cast from text), and declaring `SET search_path = ''` with the table reference inside the function body schema-qualified as `public.brokers`. The function MUST return a bare `uuid` — never a row, a record, or a table — so that no column beyond the resolved id is ever exposed through this path. Migration `0007` MUST `DROP FUNCTION` the prior `dirus_resolve_broker_id(text)` signature; it MUST NOT remain in the catalog as a second, still-reachable overload.
(Previously: `p_key text`, matched against `brokers.wa_phone_number_id`, with a `MAX_KEY_LENGTH = 256` application-level string guard instead of an integer-range check.)

#### Scenario: Function is SECURITY DEFINER, owned by the resolver role, takes an integer, and returns a scalar uuid

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_proc` is queried for `dirus_resolve_broker_id`
- THEN `prosecdef` is `true`, the function's owner (via `pg_proc.proowner` joined to `pg_roles`) is `dirus_tenant_resolver`, its single argument type is `integer`, and `prorettype` resolves to `uuid` (not a composite or table type)

#### Scenario: The old text-keyed function no longer exists after 0007

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_proc` is queried for any function named `dirus_resolve_broker_id` taking a single `text` argument
- THEN no such function exists in the catalog

#### Scenario: Function's search_path is pinned in the catalog

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_proc.proconfig` is queried for `dirus_resolve_broker_id`
- THEN `proconfig` is non-null and contains `search_path=`, with an empty value

#### Scenario: Unqualified table access inside the function cannot be hijacked by a caller-created relation

- GIVEN the resolver function's body references `public.brokers` (schema-qualified) rather than a bare `brokers`
- WHEN a caller, prior to invoking `dirus_resolve_broker_id`, creates a temporary relation named `brokers` in its own session (e.g. `CREATE TEMP TABLE brokers (...)`)
- THEN the function still resolves against `public.brokers`; the caller-created relation is never consulted

#### Scenario: Resolving an unknown key returns NULL, not an error

- GIVEN no `brokers` row has `chatwoot_account_id = 999`
- WHEN `SELECT dirus_resolve_broker_id(999)` is called
- THEN it returns `NULL` and raises no error

#### Scenario: The same lookup through an owner-owned function returns zero rows (owner control)

- GIVEN a `SECURITY DEFINER` function with the same body, but owned by the table-owning role instead of `dirus_tenant_resolver`, is called under the same unset-context session
- WHEN that owner-owned function is invoked
- THEN it returns `NULL` even for a known `chatwoot_account_id`, because `FORCE ROW LEVEL SECURITY` binds the table owner

### Requirement: dirus_app May EXECUTE the Resolver Function and Gains No Other brokers Privilege

The system MUST grant `EXECUTE` on `dirus_resolve_broker_id(integer)` to `dirus_app`, and MUST revoke the function's default `PUBLIC` `EXECUTE` grant. `dirus_app`'s privileges on `brokers` itself (columns, rows, or otherwise) MUST remain exactly what the base migrations already grant — full-table `SELECT, INSERT, UPDATE, DELETE`, gated entirely by `tenant_isolation`'s `USING`/`WITH CHECK` predicate. Migration `0007` adds no new grant on the `brokers` table itself to `dirus_app`.
(Previously: `EXECUTE` was granted on the `(text)` signature.)

#### Scenario: EXECUTE is revoked from PUBLIC and granted only to dirus_app on the new signature

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN the ACL for `dirus_resolve_broker_id(integer)` is inspected
- THEN `PUBLIC` holds no `EXECUTE` privilege, and `dirus_app` holds `EXECUTE`

#### Scenario: dirus_app can call the function without an app.broker_id context

- GIVEN `dirus_app` holds `EXECUTE` on the function and no `app.broker_id` is set in the session
- WHEN `dirus_app` calls `SELECT dirus_resolve_broker_id(555001)` for a broker known to exist
- THEN the call succeeds and returns that broker's `id`

#### Scenario: dirus_app's column-level access to brokers via GRANT is unchanged

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `dirus_app`'s privileges on `public.brokers` are inspected
- THEN they match exactly what the base migrations already grant (`SELECT, INSERT, UPDATE, DELETE` at the table level) with no new grant introduced by this migration

### Requirement: Membership in the Resolver Role Is Never Inheritable

RLS policy `TO`-clause matching uses `has_privs_of_role`, which follows `INHERIT` membership. An inheriting membership of any other role — most critically `dirus_app` — into `dirus_tenant_resolver` would make `tenant_resolver_lookup` apply to that role directly, silently reopening unrestricted `brokers` read access without touching the policy or the function at all. The system MUST ensure no such inheriting membership exists.

#### Scenario: No role holds an inheriting membership in the resolver role

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `pg_auth_members` is queried joined to `pg_roles` for memberships where the `roleid` is `dirus_tenant_resolver`
- THEN either no membership rows exist, or every membership row present has `inherit_option = false`; in particular `dirus_app` holds no membership row in `dirus_tenant_resolver`

#### Scenario: A future regression introducing an inheriting membership is caught by the catalog guard

- GIVEN a hypothetical future migration or manual operation runs `GRANT dirus_tenant_resolver TO dirus_app` without `WITH INHERIT FALSE`
- WHEN the catalog guard scenario above is re-run
- THEN it fails, because `pg_auth_members` now shows an inheriting membership of `dirus_app` in `dirus_tenant_resolver`

### Requirement: Tenant Resolution Does Not Filter on brokers.status

The resolver function MUST resolve a `broker_id` for any `brokers` row matching the lookup key, regardless of that row's `status` value. A suspended broker's webhook traffic must still resolve to a `broker_id` so it can be persisted and handled by downstream logic, rather than being silently dropped at the resolution step.
(Previously: stated against `wa_phone_number_id = p_key`; the invariant itself — no `status` predicate — is unchanged.)

#### Scenario: A suspended broker still resolves

- GIVEN a `brokers` row exists with `chatwoot_account_id = 777` and `status` set to a non-active value (e.g. `'suspended'`)
- WHEN `SELECT dirus_resolve_broker_id(777)` is called
- THEN it returns that broker's `id`, not `NULL`

#### Scenario: The function body contains no status predicate

- GIVEN the committed migration SQL for `0007_chatwoot_account_resolution.sql`
- WHEN the `dirus_resolve_broker_id` function body is inspected
- THEN its `WHERE` clause filters only on `chatwoot_account_id = p_key`, with no reference to `status`

### Requirement: The Resolver Role's Column-Scoped Grant Is Limited to id and chatwoot_account_id

The system MUST grant `dirus_tenant_resolver` `SELECT` on exactly the `(id, chatwoot_account_id)` columns of `public.brokers`, and MUST NOT leave `wa_phone_number_id` reachable through this role. This grant MUST move in the same migration (`0007`) as the function it backs (proposal P3): a function that can read the row but not the column it filters on fails with a permissions error indistinguishable from "broker not found" — a security-relevant failure that must not be introduced by a grant landing in a separate commit.

#### Scenario: The resolver role's grant is exactly id and chatwoot_account_id

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `dirus_tenant_resolver`'s column privileges on `public.brokers` are inspected (e.g. via `information_schema.column_privileges`)
- THEN `SELECT` is present for exactly `id` and `chatwoot_account_id`, and for no other column

#### Scenario: wa_phone_number_id is no longer reachable through the resolver role

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `dirus_tenant_resolver`'s column privileges on `public.brokers` are inspected
- THEN no `SELECT` privilege exists on `wa_phone_number_id` for that role

#### Scenario: The grant and the function ship in the same migration

- GIVEN the committed migration file `0007_chatwoot_account_resolution.sql`
- WHEN inspected
- THEN it contains both the `CREATE FUNCTION dirus_resolve_broker_id (integer)` statement and the `GRANT SELECT (id, chatwoot_account_id) ON public.brokers TO dirus_tenant_resolver` statement, with no dependency on a separate migration for either half

## Testing Strategy

Every scenario above MUST be assertable by a live Postgres test, following the conventions established in the base data-model specification. Catalog-derived scenarios MAY additionally be asserted structurally against the committed migration SQL text, but the negative-control scenario ("dirus_app still sees zero brokers rows directly") and the owner-control scenario MUST be proven live.

## Delta: Partial Unique Index on Numbered Policies (A1 Extension)

The following requirements extend the base data-model capability with a constraint on policies keyed by `(broker_id, policy_number)`. A1 (`policy-bulk-import`) adds an idempotent import path that upserts policies by this key — but without a unique constraint on this pair, duplicated rows would silently accumulate on re-import. This delta specifies the partial index shape that enforces idempotency while preserving non-idempotent rows (those without a `policy_number`).

### Requirement: Partial Unique Index on Numbered Policies

The system MUST enforce a **partial** unique index,
`CREATE UNIQUE INDEX … ON policies (broker_id, policy_number) WHERE
policy_number IS NOT NULL`, defining "the same policy" as a `(broker_id,
policy_number)` pair only when `policy_number` is present. This index is
required, as a distinct constraint shape, for the following reasons — a
future edit that "simplifies" it away MUST be treated as a regression, not a
cleanup:

- A plain `UNIQUE (broker_id, policy_number)` (no `WHERE` clause) would
  *appear* identical in every test that always supplies a `policy_number`,
  because Postgres treats each `NULL` as distinct from every other `NULL` in
  a standard unique index — rows with `policy_number IS NULL` would
  silently accumulate without violating it. The constraint would pass by
  accident, not by design, and would misdescribe its own intent to a reader.
- `NULLS NOT DISTINCT` (PG15+) is actively destructive here: it would
  collapse every `policy_number IS NULL` row for a given broker into a
  single row, since it treats all NULLs in the indexed columns as equal —
  destroying distinct real policies that happen to lack a policy number.
- The partial index is the only shape whose semantics match the actual
  rule: numbered policies participate in idempotency; unnumbered ones do
  not, and multiple unnumbered rows for the same broker are legitimate,
  distinct policies.

#### Scenario: Two policies with the same policy_number for the same broker are rejected

- GIVEN a `policies` row exists with `(broker_id = B, policy_number =
  "POL-1")`
- WHEN a second `INSERT` attempts `(broker_id = B, policy_number =
  "POL-1")`
- THEN the database rejects it with a unique-violation error, and only one
  row exists afterward for that pair

#### Scenario: Multiple policies with a NULL policy_number for the same broker are permitted

- GIVEN a `policies` row exists with `(broker_id = B, policy_number =
  NULL)`
- WHEN a second `INSERT` attempts `(broker_id = B, policy_number = NULL)`
- THEN the insert succeeds, and two distinct `policies` rows exist for
  broker `B` with `policy_number IS NULL`

#### Scenario: The same policy_number is permitted across different brokers

- GIVEN a `policies` row exists with `(broker_id = A, policy_number =
  "POL-9")`
- WHEN an `INSERT` attempts `(broker_id = B, policy_number = "POL-9")` for
  a different broker `B`
- THEN the insert succeeds, and one row exists for each broker with
  `policy_number = "POL-9"`

#### Scenario: The committed migration SQL encodes a partial index, not a plain or NULLS-NOT-DISTINCT one

- GIVEN the committed migration SQL adding this index
- WHEN inspected
- THEN it contains a `WHERE policy_number IS NOT NULL` clause verbatim, and
  contains no `NULLS NOT DISTINCT` clause

## Delta: Email Login Credentials and Magic-Link Tokens (C1 Extension)

The following requirements extend the base data-model capability with email-based authentication and session storage. C1 (`admin-dashboard`) adds email as a globally unique login credential on `broker_users` and introduces two new tables, `magic_link_tokens` and `sessions`, for token-based authentication and session lifecycle management.

### Requirement: broker_users.email Is a Nullable, Globally Unique Login Credential

The system MUST add a nullable `email` column to `broker_users`, enforced
`UNIQUE` **globally** (not scoped to `broker_id`, unlike `phone`'s
`UNIQUE (broker_id, phone)`). A `broker_users` row with `email IS NULL`
MUST remain a fully valid WhatsApp-side actor for the existing F2 ingress
and A1 import paths; email is required only at the dashboard login
application boundary, never at the schema level.

Rationale for global uniqueness, diverging deliberately from `phone`'s
broker-scoped pattern: `phone` identifies a person within a broker's book
of business and is looked up only after `broker_id` is already known
(e.g. via tenant resolution). `email` is looked up by the magic-link
request/callback flow *before* any broker context exists — that is the
entire premise of the login flow. A `UNIQUE (broker_id, email)` constraint
would leave "which `broker_user` is this?" genuinely ambiguous if the same
email were duplicated across two brokers, because the lookup has no
`broker_id` to disambiguate with at that point. `phone` and `email` serve
different roles — a business identifier looked up within a known tenant,
versus a login credential looked up before any tenant is known — so they
correctly receive different constraint shapes.

#### Scenario: A broker_users row without an email remains valid

- GIVEN a `broker_users` row created by the existing F2/A1 paths with no
  `email` value supplied
- WHEN the row is inserted
- THEN the insert succeeds with `email IS NULL`, and the row functions
  normally as a WhatsApp-side actor

#### Scenario: A duplicate email across two different brokers is rejected

- GIVEN a `broker_users` row exists with `email = "ana@brokerx.com"` under
  broker A
- WHEN a second `broker_users` row is inserted with
  `email = "ana@brokerx.com"` under a different broker, broker B
- THEN the database rejects the insert with a unique-violation error

#### Scenario: Multiple broker_users rows with NULL email are permitted

- GIVEN a `broker_users` row exists with `email IS NULL`
- WHEN a second `broker_users` row is inserted with `email IS NULL`,
  regardless of broker
- THEN the insert succeeds — `NULL` values do not participate in the
  unique constraint

### Requirement: magic_link_tokens Table Stores Hashed, Single-Use, Expiring Tokens

The system MUST define a `magic_link_tokens` table with columns `id`,
`broker_id` (`NOT NULL`, references `brokers.id`), `broker_user_id`
(`NOT NULL`, references `broker_users.id`), `token_hash` (`NOT NULL`,
never the raw token), `expires_at` (`NOT NULL`, timestamp), `used_at`
(nullable timestamp, following the same "presence means it happened"
pattern already used by `contacts.consent_at`), and `created_at`
(`NOT NULL`, default now). `broker_id` MUST be present because every
table in this schema carries one — multi-tenant scoping is this project's
convention from line one, and RLS must apply to this table uniformly with
every other `broker_id`-bearing table.

#### Scenario: A magic_link_tokens row requires broker_id and broker_user_id

- GIVEN an attempted insert into `magic_link_tokens` omitting `broker_id`
  or `broker_user_id`
- WHEN the insert runs
- THEN it is rejected — both columns are `NOT NULL`

#### Scenario: used_at is nullable and defaults unset

- GIVEN a freshly issued magic-link token row
- WHEN the row is inserted without specifying `used_at`
- THEN the insert succeeds with `used_at IS NULL`, and setting it later
  (on consumption) is a subsequent `UPDATE`, not part of the initial insert

### Requirement: magic_link_tokens Is RLS-Scoped Like Every Other broker_id Table

`magic_link_tokens` MUST have `ENABLE ROW LEVEL SECURITY` and
`FORCE ROW LEVEL SECURITY`, with a policy restricting rows to
`broker_id = current_setting('app.broker_id')::uuid`, identical in shape to
every other `broker_id`-bearing table's policy in this schema.

#### Scenario: Unset broker context returns zero magic_link_tokens rows

- GIVEN a live connection using the application role with `app.broker_id`
  never set in the session
- WHEN `SELECT * FROM magic_link_tokens` runs
- THEN zero rows are returned, even though rows exist for multiple brokers

#### Scenario: Broker A cannot read Broker B's magic_link_tokens rows

- GIVEN broker A and broker B each have at least one `magic_link_tokens`
  row
- WHEN a transaction sets `app.broker_id = A` and queries
  `magic_link_tokens`
- THEN only rows belonging to broker A are returned
