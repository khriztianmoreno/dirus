# Data Model Delta: Tenant Resolver Role (D-1)

## Purpose

F2 needs a request holding only a `wa_phone_number_id` to learn its
`broker_id` before any tenant-scoped query can run — but the existing
`brokers` policy (`tenant_isolation`, `packages/db/migrations/0002_rls_policies.sql`)
requires `app.broker_id` to already be set, which is exactly what tenant
resolution has not happened yet. This delta specifies the invariants
`packages/db/migrations/0004_tenant_resolver.sql` must satisfy so that a
narrow, single-column lookup path can exist without widening `brokers`
read access for `dirus_app` in general.

**STATUS (apply, Phase 1): migration and live test written and reviewed,
live proof still PENDING CI.** `packages/db/migrations/0004_tenant_resolver.sql`
and `packages/db/test/migrations/live-tenant-resolution.test.ts` now exist and
implement every requirement/scenario below, including the negative control,
owner control, membership-guard mutation, and search_path-hijack scenarios.
No Postgres, Docker, or Podman was reachable in the apply session that wrote
them (same constraint `design.md` records for the design session) — the
structural test (`packages/db/test/migrations/tenant-resolver-migration.test.ts`)
and typecheck/lint were run and pass; the live assertions themselves have
**not executed anywhere yet**. `packages/db/apply-progress.md` records exactly
what ran versus what is unverified. Do not treat this spec, or the migration
SQL, as proof the mechanism works until CI's `pgvector/pgvector:pg17` run of
`live-tenant-resolution.test.ts` is green — that is task 1.7 in
`tasks.md`, the acceptance gate, and it is explicitly still open.

This delta modifies the `data-model` capability
(`openspec/changes/scaffold-monorepo/specs/data-model/spec.md`, "Row Level
Security Enforced and Forced" and the surrounding requirements). It does not
restate that capability's existing requirements — `tenant_isolation` on
`brokers` and the other eight tables is unchanged by this delta and remains
governed by that spec.

## Requirements

### Requirement: Dedicated Tenant Resolver Role Exists and Cannot Log In

The system MUST define a role, `dirus_tenant_resolver`, that is `NOLOGIN`,
`NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, and `NOCREATEROLE`. This role is
a privilege container a `SECURITY DEFINER` function assumes for the
duration of its body — it is never a connection identity, and no
application code or human ever authenticates as it directly.

#### Scenario: Resolver role exists and cannot establish a session

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `pg_roles` is queried for `rolname = 'dirus_tenant_resolver'`
- THEN exactly one row is returned with `rolcanlogin = false`,
  `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, and
  `rolcreaterole = false`

#### Scenario: Direct connection as the resolver role is refused

- GIVEN the resolver role exists
- WHEN a client attempts to open a database session authenticating as
  `dirus_tenant_resolver`
- THEN Postgres refuses the connection (`NOLOGIN` role)

### Requirement: The Permissive brokers Lookup Policy Is Scoped to the Resolver Role Only

The system MUST add a permissive `SELECT` policy on `brokers`,
`tenant_resolver_lookup`, whose `TO` clause names only
`dirus_tenant_resolver`. This policy is additional to, and does not modify,
the existing `tenant_isolation` policy from
`packages/db/migrations/0002_rls_policies.sql`, which continues to govern
every role not matching `tenant_resolver_lookup`'s `TO` clause — most
importantly `dirus_app`. Because Postgres combines multiple permissive
policies for the same command with `OR`, any role for which both policies
apply would see the union of both — this is precisely what must not happen
for `dirus_app`.

#### Scenario: The permissive lookup policy names only the resolver role

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `pg_policies` (or `pg_policy` joined to `pg_roles`) is queried for
  the policy `tenant_resolver_lookup` on `brokers`
- THEN its `roles` array contains exactly `{dirus_tenant_resolver}` and no
  other role, including `dirus_app` and the table owner

#### Scenario: dirus_app in a session that just resolved a broker still sees zero brokers rows directly (negative control)

- GIVEN a live database with migrations `0000`, `0002`, and `0004` applied,
  and at least one `brokers` row exists
- WHEN, in a single session authenticated as `dirus_app` with no
  `app.broker_id` ever set, `SELECT dirus_resolve_broker_id('phoneA')` is
  called and successfully returns a broker id, and immediately afterward,
  in that same session, `SELECT * FROM brokers` and
  `SELECT count(*) FROM brokers` are run
- THEN both queries return zero rows — a successful resolver call MUST NOT
  leave the session able to read `brokers` directly; if either query
  returns anything non-zero, the design is wrong and MUST NOT ship

  **NEEDS EMPIRICAL PROOF** — this is the single most important scenario in
  this delta. A scenario that only asserts the resolver's happy path
  cannot distinguish a working mechanism from a permissive one; this
  negative control is what does that distinguishing.

#### Scenario: tenant_isolation on brokers is unchanged by this migration

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `pg_policies` is queried for all policies on `brokers`
- THEN the `tenant_isolation` policy from `0002_rls_policies.sql` still
  exists with its original `USING`/`WITH CHECK` predicate and its original
  `TO` scope (all roles, i.e. no `TO` restriction), and exactly one
  additional policy (`tenant_resolver_lookup`) is present

### Requirement: The Resolver Function Is SECURITY DEFINER, Owned by the Resolver Role, Returns a Bare uuid, and Has a Pinned search_path

The system MUST define `public.dirus_resolve_broker_id(p_key text) RETURNS uuid`
as `SECURITY DEFINER`, owned by `dirus_tenant_resolver`, taking the
resolution key as a bound parameter (never string-interpolated), and
declaring `SET search_path = ''` with the table reference inside the
function body schema-qualified as `public.brokers`. The function MUST
return a bare `uuid` — never a row, a record, or a table — so that no
column beyond the resolved id is ever exposed through this path.

#### Scenario: Function is SECURITY DEFINER, owned by the resolver role, and returns a scalar uuid

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `pg_proc` is queried for `dirus_resolve_broker_id`
- THEN `prosecdef` is `true`, the function's owner (via `pg_proc.proowner`
  joined to `pg_roles`) is `dirus_tenant_resolver`, and `prorettype`
  resolves to `uuid` (not a composite or table type)

#### Scenario: Function's search_path is pinned in the catalog

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `pg_proc.proconfig` is queried for `dirus_resolve_broker_id`
- THEN `proconfig` is non-null and contains `search_path=`, with an empty
  value

#### Scenario: Unqualified table access inside the function cannot be hijacked by a caller-created relation

- GIVEN the resolver function's body references `public.brokers` (schema-
  qualified) rather than a bare `brokers`
- WHEN a caller, prior to invoking `dirus_resolve_broker_id`, creates a
  temporary relation named `brokers` in its own session (e.g.
  `CREATE TEMP TABLE brokers (...)`, which Postgres places in an implicitly
  first-searched `pg_temp_N` schema)
- THEN the function still resolves against `public.brokers`; the caller-
  created relation is never consulted, because `pg_temp_N.brokers` cannot
  match a schema-qualified reference

  **NEEDS EMPIRICAL PROOF** — this is a supporting scenario for the
  `search_path` hijack risk `design.md` D-1 names explicitly; it has not
  been executed against live Postgres.

#### Scenario: Resolving an unknown key returns NULL, not an error

- GIVEN no `brokers` row has `wa_phone_number_id = 'unknown'`
- WHEN `SELECT dirus_resolve_broker_id('unknown')` is called
- THEN it returns `NULL` and raises no error

#### Scenario: The same lookup through an owner-owned function returns zero rows (owner control)

- GIVEN a `SECURITY DEFINER` function with the same body, but owned by the
  table-owning role instead of `dirus_tenant_resolver`, is called under the
  same unset-context session
- WHEN that owner-owned function is invoked
- THEN it returns `NULL` even for a known key, because `FORCE ROW LEVEL
  SECURITY` binds the table owner (re-proving, per the existing
  `data-model` spec's "FORCE applies to the table owner" scenario and this
  file's negative control, that the resolver role — not `SECURITY DEFINER`
  alone — is what makes the working function work)

### Requirement: dirus_app May EXECUTE the Resolver Function and Gains No Other brokers Privilege

The system MUST grant `EXECUTE` on `dirus_resolve_broker_id(text)` to
`dirus_app`, and MUST revoke the function's default `PUBLIC` `EXECUTE`
grant. `dirus_app`'s privileges on `brokers` itself (columns, rows, or
otherwise) MUST remain exactly what `0003_app_role_grants.sql` already
grants — full-table `SELECT, INSERT, UPDATE, DELETE`, gated entirely by
`tenant_isolation`'s `USING`/`WITH CHECK` predicate. This migration adds no
new grant on the `brokers` table itself to `dirus_app`.

#### Scenario: EXECUTE is revoked from PUBLIC and granted only to dirus_app

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN the ACL for `dirus_resolve_broker_id(text)` is inspected (e.g.
  `SELECT proacl FROM pg_proc WHERE proname = 'dirus_resolve_broker_id'`,
  or an equivalent `has_function_privilege` check)
- THEN `PUBLIC` holds no `EXECUTE` privilege, and `dirus_app` holds
  `EXECUTE`

#### Scenario: dirus_app can call the function without an app.broker_id context

- GIVEN `dirus_app` holds `EXECUTE` on the function and no `app.broker_id`
  is set in the session
- WHEN `dirus_app` calls `SELECT dirus_resolve_broker_id('phoneA')` for a
  broker known to exist
- THEN the call succeeds and returns that broker's `id`

#### Scenario: dirus_app's column-level access to brokers via GRANT is unchanged

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `dirus_app`'s privileges on `public.brokers` are inspected (e.g.
  `information_schema.role_table_grants`)
- THEN they match exactly what `0003_app_role_grants.sql` already grants
  (`SELECT, INSERT, UPDATE, DELETE` at the table level) with no new grant
  introduced by this migration; the resolver's column-scoped `GRANT SELECT
  (id, wa_phone_number_id) ... TO dirus_tenant_resolver` applies to the
  resolver role, not to `dirus_app`

### Requirement: Membership in the Resolver Role Is Never Inheritable

RLS policy `TO`-clause matching uses `has_privs_of_role`, which follows
`INHERIT` membership. An inheriting membership of any other role — most
critically `dirus_app` — into `dirus_tenant_resolver` would make
`tenant_resolver_lookup` apply to that role directly, silently reopening
unrestricted `brokers` read access without touching the policy or the
function at all. The system MUST ensure no such inheriting membership
exists, including any membership incidentally created by migration
tooling (e.g. `ALTER FUNCTION ... OWNER TO dirus_tenant_resolver`, which
requires the migration role to hold membership in the target role — that
membership MUST be granted `WITH INHERIT FALSE`).

#### Scenario: No role holds an inheriting membership in the resolver role

- GIVEN migration `0004_tenant_resolver.sql` has been applied
- WHEN `pg_auth_members` is queried joined to `pg_roles` for memberships
  where the `roleid` is `dirus_tenant_resolver`
- THEN either no membership rows exist, or every membership row present
  has `inherit_option = false`; in particular `dirus_app` holds no
  membership row — inheriting or not — in `dirus_tenant_resolver`

#### Scenario: A future regression introducing an inheriting membership is caught by the catalog guard

- GIVEN a hypothetical future migration or manual operation runs
  `GRANT dirus_tenant_resolver TO dirus_app` without `WITH INHERIT FALSE`
  (the default is inheritable)
- WHEN the catalog guard scenario above is re-run against that state
- THEN it fails, because `pg_auth_members` now shows an inheriting
  membership of `dirus_app` in `dirus_tenant_resolver` — this scenario is a
  guard against a future regression, not a claim that today's migration
  introduces one

### Requirement: Tenant Resolution Does Not Filter on brokers.status

The resolver function MUST resolve a `broker_id` for any `brokers` row
matching the lookup key, regardless of that row's `status` value. This is
a settled product decision (proposal P5): a suspended broker's webhook
traffic must still resolve to a `broker_id` so it can be persisted and
handled by downstream logic, rather than being silently dropped at the
resolution step. `dirus_resolve_broker_id` MUST NOT gain a
`WHERE status = 'active'` (or equivalent) predicate now or in a future
change without a new product decision revisiting P5.

#### Scenario: A suspended broker still resolves

- GIVEN a `brokers` row exists with `wa_phone_number_id = 'phoneS'` and
  `status` set to a non-active value (e.g. `'suspended'`)
- WHEN `SELECT dirus_resolve_broker_id('phoneS')` is called
- THEN it returns that broker's `id`, not `NULL`

#### Scenario: The function body contains no status predicate

- GIVEN the committed migration SQL for `0004_tenant_resolver.sql`
- WHEN the `dirus_resolve_broker_id` function body is inspected
- THEN its `WHERE` clause filters only on `wa_phone_number_id = p_key`,
  with no reference to `status`

## Testing Strategy

Every scenario above MUST be assertable by a live Postgres test extending
`packages/db/test/migrations/live-tenant-resolution.test.ts`, following the
conventions established in
`packages/db/test/migrations/live-rls-verification.test.ts`:
`describe.skipIf(!LIVE_TEST_DATABASE_URL)`, a per-run throwaway schema
(`throwaway-schema.ts`), `assertThrowawayDatabase` before any destructive
statement, disposable fixture roles scoped to this suite (never a role
literally named `dirus_app` or `dirus_tenant_resolver` in the real
cluster), and `afterAll` teardown gated on a `safeToMutate` flag. Catalog-
derived scenarios (role flags, policy `TO` roles, function ACL,
`pg_auth_members`) MAY additionally be asserted structurally against the
committed migration SQL text and against `pg_catalog`, in the style of
`rls-catalog-guard.test.ts`, but the negative-control scenario ("dirus_app
... still sees zero brokers rows directly") and the owner-control scenario
MUST be proven live — a structural assertion cannot demonstrate what
Postgres actually enforces at query time.
