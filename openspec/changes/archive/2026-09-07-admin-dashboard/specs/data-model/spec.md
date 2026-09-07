# Delta for Data Model

## ADDED Requirements

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

## Status: Phase 1 gate (design.md D-A) — apply-run record

Written in an environment with no Postgres/Docker/Podman reachable (same
constraint design.md's D-A section states). `migrations/0006_broker_auth.sql`
and `test/migrations/broker-auth-migration.test.ts` (structural, offline) are
committed and GREEN locally. `test/migrations/live-broker-auth.test.ts`
implements all five of design D-A's live assertions plus tasks 1.8/1.9's two
additional live proofs, gated on `BROKER_AUTH_TEST_DATABASE_URL`
(`describe.skipIf`) — it correctly SKIPPED in this environment (16 tests
collected, 0 executed) rather than reporting a false pass. **D-A's live proof
has NOT yet executed** — it is pending the next CI run against the service
container (`.github/workflows/ci.yml` now provisions
`dirus_broker_auth_test`). Phase 2 MUST NOT start until that CI run is
observed green; per tasks.md's ordering constraint, a failure of assertion 2
(negative control) or assertion 4 (catalog guard) is a design-level stop-ship
signal, not an implementation bug to patch around. See
`apply-progress.md` for the full Phase 1 record.
