# Data Model Specification

## Purpose

Define the DIRUS persistence schema (§7.1/§7.2 of `docs/ARCHITECTURE.md`), its idempotency constraints, and multi-tenant isolation via Postgres Row Level Security, migrated to a live Neon database.

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

The system MUST enforce these UNIQUE constraints, each preventing a specific real-world duplication: `messages.wa_message_id` (Meta/Chatwoot webhook replay dedup), `renewals(policy_id, due_date)` (renewal cron re-run dedup), `contacts(broker_id, phone)`, `broker_users(broker_id, phone)`, `brokers.wa_phone_number_id` (tenant resolution per webhook).

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
