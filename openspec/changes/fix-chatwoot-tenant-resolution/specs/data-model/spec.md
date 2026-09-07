# Delta for Data Model

Supersedes the "Delta: Tenant Resolver Role (F2 Extension)" block
(`openspec/specs/data-model/spec.md:139-266`), which named
`wa_phone_number_id` as the resolver's lookup key and parameter — a key
never present in a real Chatwoot payload. Per proposal P4, this delta
REPLACES the named requirement blocks below at archive time; it does not
sit alongside them. The security envelope (role shape, permissive-policy
`TO`-scoping, `SECURITY DEFINER`/owner/pinned-`search_path` binding,
non-inheritable membership, no-`status`-predicate) is unchanged and is
re-stated verbatim below, not relaxed.

## MODIFIED Requirements

### Requirement: The Permissive brokers Lookup Policy Is Scoped to the Resolver Role Only

The system MUST add a permissive `SELECT` policy on `brokers`,
`tenant_resolver_lookup`, whose `TO` clause names only
`dirus_tenant_resolver`. This policy is additional to, and does not modify,
the existing `tenant_isolation` policy, which continues to govern every role
not matching `tenant_resolver_lookup`'s `TO` clause — most importantly
`dirus_app`. Because Postgres combines multiple permissive policies for the
same command with `OR`, any role for which both policies apply would see
the union of both — this is precisely what must not happen for `dirus_app`.
(Previously: the negative-control scenario called
`dirus_resolve_broker_id('phoneA')`, a text-keyed lookup; migration `0007`
replaces it with an integer-keyed call. No other change.)

#### Scenario: The permissive lookup policy names only the resolver role

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_policies` (or `pg_policy` joined to `pg_roles`) is queried for the
  policy `tenant_resolver_lookup` on `brokers`
- THEN its `roles` array contains exactly `{dirus_tenant_resolver}` and no
  other role, including `dirus_app` and the table owner

#### Scenario: dirus_app in a session that just resolved a broker still sees zero brokers rows directly (negative control)

- GIVEN a live database with the base migrations and `0007` applied, with at
  least one `brokers` row existing at a known `chatwoot_account_id = 555001`
- WHEN, in a single session authenticated as `dirus_app` with no
  `app.broker_id` ever set, `SELECT dirus_resolve_broker_id(555001)` is
  called and successfully returns a broker id, and immediately afterward, in
  that same session, `SELECT * FROM brokers` and `SELECT count(*) FROM
  brokers` are run
- THEN both queries return zero rows — a successful resolver call MUST NOT
  leave the session able to read `brokers` directly; if either query returns
  anything non-zero, the design is wrong

#### Scenario: tenant_isolation on brokers is unchanged by this migration

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_policies` is queried for all policies on `brokers`
- THEN the `tenant_isolation` policy from the base migration still exists
  with its original `USING`/`WITH CHECK` predicate and its original `TO`
  scope, and exactly one additional policy (`tenant_resolver_lookup`) is
  present

### Requirement: The Resolver Function Is SECURITY DEFINER, Owned by the Resolver Role, Takes an Integer Key, Returns a Bare uuid, and Has a Pinned search_path

The system MUST define `public.dirus_resolve_broker_id(p_key integer)
RETURNS uuid` as `SECURITY DEFINER`, owned by `dirus_tenant_resolver`,
taking the resolution key as a bound integer parameter (never
string-interpolated, never cast from text), and declaring `SET search_path
= ''` with the table reference inside the function body schema-qualified as
`public.brokers`. The function MUST return a bare `uuid` — never a row, a
record, or a table — so that no column beyond the resolved id is ever
exposed through this path. Migration `0007` MUST `DROP FUNCTION` the prior
`dirus_resolve_broker_id(text)` signature; it MUST NOT remain in the catalog
as a second, still-reachable overload.
(Previously: `p_key text`, matched against `brokers.wa_phone_number_id`,
with a `MAX_KEY_LENGTH = 256` application-level string guard instead of an
integer-range check.)

#### Scenario: Function is SECURITY DEFINER, owned by the resolver role, takes an integer, and returns a scalar uuid

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_proc` is queried for `dirus_resolve_broker_id`
- THEN `prosecdef` is `true`, the function's owner (via `pg_proc.proowner`
  joined to `pg_roles`) is `dirus_tenant_resolver`, its single argument type
  is `integer`, and `prorettype` resolves to `uuid` (not a composite or
  table type)

#### Scenario: The old text-keyed function no longer exists after 0007

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_proc` is queried for any function named `dirus_resolve_broker_id`
  taking a single `text` argument
- THEN no such function exists in the catalog

#### Scenario: Function's search_path is pinned in the catalog

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `pg_proc.proconfig` is queried for `dirus_resolve_broker_id`
- THEN `proconfig` is non-null and contains `search_path=`, with an empty
  value

#### Scenario: Unqualified table access inside the function cannot be hijacked by a caller-created relation

- GIVEN the resolver function's body references `public.brokers`
  (schema-qualified) rather than a bare `brokers`
- WHEN a caller, prior to invoking `dirus_resolve_broker_id`, creates a
  temporary relation named `brokers` in its own session (e.g. `CREATE TEMP
  TABLE brokers (...)`)
- THEN the function still resolves against `public.brokers`; the
  caller-created relation is never consulted

#### Scenario: Resolving an unknown key returns NULL, not an error

- GIVEN no `brokers` row has `chatwoot_account_id = 999`
- WHEN `SELECT dirus_resolve_broker_id(999)` is called
- THEN it returns `NULL` and raises no error

#### Scenario: The same lookup through an owner-owned function returns zero rows (owner control)

- GIVEN a `SECURITY DEFINER` function with the same body, but owned by the
  table-owning role instead of `dirus_tenant_resolver`, is called under the
  same unset-context session
- WHEN that owner-owned function is invoked
- THEN it returns `NULL` even for a known `chatwoot_account_id`, because
  `FORCE ROW LEVEL SECURITY` binds the table owner

### Requirement: dirus_app May EXECUTE the Resolver Function and Gains No Other brokers Privilege

The system MUST grant `EXECUTE` on `dirus_resolve_broker_id(integer)` to
`dirus_app`, and MUST revoke the function's default `PUBLIC` `EXECUTE`
grant. `dirus_app`'s privileges on `brokers` itself (columns, rows, or
otherwise) MUST remain exactly what the base migrations already grant —
full-table `SELECT, INSERT, UPDATE, DELETE`, gated entirely by
`tenant_isolation`'s `USING`/`WITH CHECK` predicate. Migration `0007` adds
no new grant on the `brokers` table itself to `dirus_app`.
(Previously: `EXECUTE` was granted on the `(text)` signature.)

#### Scenario: EXECUTE is revoked from PUBLIC and granted only to dirus_app on the new signature

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN the ACL for `dirus_resolve_broker_id(integer)` is inspected
- THEN `PUBLIC` holds no `EXECUTE` privilege, and `dirus_app` holds `EXECUTE`

#### Scenario: dirus_app can call the function without an app.broker_id context

- GIVEN `dirus_app` holds `EXECUTE` on the function and no `app.broker_id`
  is set in the session
- WHEN `dirus_app` calls `SELECT dirus_resolve_broker_id(555001)` for a
  broker known to exist
- THEN the call succeeds and returns that broker's `id`

#### Scenario: dirus_app's column-level access to brokers via GRANT is unchanged

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `dirus_app`'s privileges on `public.brokers` are inspected
- THEN they match exactly what the base migrations already grant (`SELECT,
  INSERT, UPDATE, DELETE` at the table level) with no new grant introduced
  by this migration

### Requirement: Tenant Resolution Does Not Filter on brokers.status

The resolver function MUST resolve a `broker_id` for any `brokers` row
matching the lookup key, regardless of that row's `status` value. A
suspended broker's webhook traffic must still resolve to a `broker_id` so it
can be persisted and handled by downstream logic, rather than being
silently dropped at the resolution step.
(Previously: stated against `wa_phone_number_id = p_key`; the invariant
itself — no `status` predicate — is unchanged.)

#### Scenario: A suspended broker still resolves

- GIVEN a `brokers` row exists with `chatwoot_account_id = 777` and `status`
  set to a non-active value (e.g. `'suspended'`)
- WHEN `SELECT dirus_resolve_broker_id(777)` is called
- THEN it returns that broker's `id`, not `NULL`

#### Scenario: The function body contains no status predicate

- GIVEN the committed migration SQL for
  `0007_chatwoot_account_resolution.sql`
- WHEN the `dirus_resolve_broker_id` function body is inspected
- THEN its `WHERE` clause filters only on `chatwoot_account_id = p_key`,
  with no reference to `status`

## ADDED Requirements

### Requirement: The Resolver Role's Column-Scoped Grant Is Limited to id and chatwoot_account_id

The system MUST grant `dirus_tenant_resolver` `SELECT` on exactly the
`(id, chatwoot_account_id)` columns of `public.brokers`, and MUST NOT leave
`wa_phone_number_id` reachable through this role. This grant MUST move in
the same migration (`0007`) as the function it backs (proposal P3): a
function that can read the row but not the column it filters on fails with
a permissions error indistinguishable from "broker not found" — a
security-relevant failure that must not be introduced by a grant landing in
a separate commit.

#### Scenario: The resolver role's grant is exactly id and chatwoot_account_id

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `dirus_tenant_resolver`'s column privileges on `public.brokers` are
  inspected (e.g. via `information_schema.column_privileges`)
- THEN `SELECT` is present for exactly `id` and `chatwoot_account_id`, and
  for no other column

#### Scenario: wa_phone_number_id is no longer reachable through the resolver role

- GIVEN migration `0007_chatwoot_account_resolution.sql` has been applied
- WHEN `dirus_tenant_resolver`'s column privileges on `public.brokers` are
  inspected
- THEN no `SELECT` privilege exists on `wa_phone_number_id` for that role

#### Scenario: The grant and the function ship in the same migration

- GIVEN the committed migration file `0007_chatwoot_account_resolution.sql`
- WHEN inspected
- THEN it contains both the `CREATE FUNCTION dirus_resolve_broker_id
  (integer)` statement and the `GRANT SELECT (id, chatwoot_account_id) ON
  public.brokers TO dirus_tenant_resolver` statement, with no dependency on
  a separate migration for either half
