-- design.md D-C/D-D: `dirus_resolve_broker_id` never resolved a single real
-- Chatwoot webhook — its predicate column (`0004_tenant_resolver.sql`'s
-- `wa_phone_number_id`) is never populated by any real Chatwoot payload's
-- actual shape (confirmed live against a self-hosted Chatwoot instance).
-- The resolution key is `payload.account.id` (design D-A), which maps to
-- `brokers.chatwoot_account_id` (an `integer`, already `UNIQUE` and
-- indexed — `0000_init.sql`). This migration drops the broken `(text)`
-- signature and creates a new `(integer)` signature keyed on that column.
-- `CREATE OR REPLACE` cannot do this: Postgres treats a parameter-type
-- change as a distinct function, so `CREATE OR REPLACE` would *add an
-- overload* rather than replace anything, leaving the broken, still-
-- `EXECUTE`-granted `(text)` path reachable (proposal P1: no second path).
--
-- `0004_tenant_resolver.sql` is NOT touched by this migration — it has
-- already been applied to a real database and must stay byte-identical to
-- its archived state (proposal P3, Success Criteria item 11).

-- Step 1: membership grant, first. Both step 2 (SET ROLE to drop) and step
-- 4 (ALTER FUNCTION ... OWNER TO) depend on this membership, and neither
-- should discover it is missing halfway through. Re-issued here rather than
-- assumed from 0004, because 0007 may be applied by a different role than
-- the one that applied 0004 (a fresh clone applies the whole sequence as
-- one role; a deployed database may not). `WITH INHERIT FALSE` is the same
-- load-bearing choice 0004 made: it confers no standing privilege — in
-- particular it must never make `tenant_resolver_lookup` apply to this
-- session directly (0004's same reasoning) — while still permitting
-- `SET ROLE` (the `SET` option defaults to TRUE in PG16+).
GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;
--> statement-breakpoint

-- Step 2: drop the old (text) signature — design D-C, status NEEDS
-- EMPIRICAL PROOF against a non-superuser role (task 1.5). `DROP FUNCTION`
-- requires ownership; the function is owned by `dirus_tenant_resolver`, and
-- 0004 granted that membership WITH INHERIT FALSE precisely so it confers
-- no standing privilege — so a non-superuser migration role (every real
-- Neon connection) cannot drop this function directly. `SET ROLE` to a
-- NOLOGIN role is legal (NOLOGIN blocks connection, not role assumption)
-- and is scoped to the session, reverting even if the migration aborts
-- between here and RESET ROLE — the explicitly rejected alternative is
-- re-granting the membership WITH INHERIT TRUE for the duration, which
-- would make tenant_resolver_lookup apply to this session (F2 D-1's
-- failure mode 1) for as long as the grant survives.
--
-- Before the create, not after: the catalog must never hold two
-- `dirus_resolve_broker_id` overloads at once — with both present, an
-- unadorned `SELECT dirus_resolve_broker_id('1')` (a quoted literal, as a
-- psql session or a stale caller would write it) resolves to the `text`
-- overload by preference and silently returns NULL, which is exactly P1's
-- "broken path still reachable" failure.
--
-- No CASCADE: if some dependent object exists that this analysis missed,
-- the migration must fail loudly rather than silently drop it. No
-- IF EXISTS: a catalog where `dirus_resolve_broker_id(text)` is absent
-- before 0007 runs has diverged from the migration history, and that
-- deserves a failure, not a shrug. Dependency check performed at design
-- time: the only EXECUTE grantee is `dirus_app` (a privilege on the
-- function, dropped with it — not a blocker); nothing else (no view, index,
-- default expression, policy, generated column, or other function body)
-- references it; the only caller is application code
-- (`packages/db/src/tenant-resolution.ts`), not a catalog dependency.
SET ROLE dirus_tenant_resolver;
DROP FUNCTION public.dirus_resolve_broker_id(text);
RESET ROLE;
--> statement-breakpoint

-- Step 3: create the new (integer) function. After the drop, before any
-- grant below (every grant names this signature). Diff against 0004's
-- function, in full: `p_key text` -> `p_account_id integer`;
-- `wa_phone_number_id = p_key` -> `chatwoot_account_id = p_account_id`.
-- Nothing else — same name, same `LANGUAGE sql STABLE`, same
-- `SECURITY DEFINER`, same pinned empty `search_path` (plus the
-- schema-qualified `public.brokers` reference — together the search_path-
-- hijack defense), same bare `uuid` return, same absence of any `status`
-- predicate (F2 P5 stands: a suspended broker still resolves).
CREATE FUNCTION public.dirus_resolve_broker_id(p_account_id integer) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$ SELECT id FROM public.brokers WHERE chatwoot_account_id = p_account_id $$;
--> statement-breakpoint

-- Step 4: transfer ownership. `ALTER FUNCTION ... OWNER TO` requires the
-- migration role to hold membership in the target role (granted in step 1)
-- AND requires the NEW owner to hold CREATE on the function's schema at the
-- moment of transfer (0004's/0006's documented workaround for the same
-- gap). `dirus_tenant_resolver` is meant to hold only USAGE standingly —
-- CREATE is granted here only long enough for the ALTER OWNER, then
-- immediately revoked so the role's privilege set returns to its
-- documented minimal shape.
GRANT CREATE ON SCHEMA public TO dirus_tenant_resolver;
ALTER FUNCTION public.dirus_resolve_broker_id(integer) OWNER TO dirus_tenant_resolver;
REVOKE CREATE ON SCHEMA public FROM dirus_tenant_resolver;
--> statement-breakpoint

-- Step 5: EXECUTE privileges. Functions grant EXECUTE to PUBLIC by default
-- — this REVOKE is load-bearing, not decoration.
--
-- LIVE-VERIFIED GOTCHA (task 1.5, discovered running this migration for
-- real against a non-superuser Neon connection): `REVOKE` does not error
-- when the executing role lacks grant-option provenance on the ACL entry
-- being revoked — it silently does nothing. The function is owned by
-- `dirus_tenant_resolver`; PUBLIC's default EXECUTE grant is attributed to
-- that same role as grantor. The ordinary migration role (every real Neon
-- connection) is only a non-inheriting member of `dirus_tenant_resolver`
-- (step 1's `WITH INHERIT FALSE`, by design), so it cannot act as that
-- grantor without `SET ROLE` — a third instance of the same class of gap
-- `0004`'s `ALTER FUNCTION ... OWNER TO` (needs CREATE on schema) and this
-- migration's own `DROP FUNCTION` (needs `SET ROLE` to own) already hit.
-- Unlike those two, a failure here throws no error and fails no test that
-- only checks for an exception — it must be checked by reading `pg_proc
-- .proacl` directly, which is exactly what this file's own migration test
-- and the live security-boundary suite now do.
--
-- The GRANT below stays behind a `pg_roles` existence guard, mirroring
-- 0003/0004/0006's shared pattern, so a fresh clone (dirus_app not yet
-- provisioned) migrates cleanly.
SET ROLE dirus_tenant_resolver;
REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app') THEN
    GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id(integer) TO dirus_app;
  END IF;
END
$$;
RESET ROLE;
--> statement-breakpoint

-- Step 5b, discovered by the same live proof, out of this change's
-- original scope but the identical root cause and identical fix: the three
-- `SECURITY DEFINER` functions `0006_broker_auth.sql` created
-- (`dirus_resolve_broker_id_by_{email,magic_link,session}`) ran the exact
-- same unqualified `REVOKE ALL ... FROM PUBLIC` pattern, owned by the same
-- `dirus_tenant_resolver` role, and it silently no-op'd there too —
-- confirmed live in this same database (`pg_proc.proacl` showed PUBLIC
-- still holding EXECUTE on all three before this statement). `0006` itself
-- is not touched (same immutability rule as `0004`); this re-applies the
-- REVOKE correctly, under `SET ROLE`, as an idempotent correction. Running
-- this against a database where the REVOKE already succeeded (e.g. a
-- future clone where 0006 is regenerated to include `SET ROLE` directly)
-- is a harmless no-op — revoking an already-absent grant is not an error.
--
-- Guarded by `to_regprocedure` existence checks: not every environment
-- that applies `0007` has `0006` applied first — `live-tenant-resolution
-- .test.ts` deliberately applies only 0000/0002/0004(/0007) to test the
-- resolver mechanism in isolation from broker-auth (design D-1's own
-- scope), so these three functions legitimately do not exist there.
-- Unlike `DROP FUNCTION`, `REVOKE` has no `IF EXISTS` clause — the guard is
-- built with `to_regprocedure`, which returns NULL (not an error) for a
-- signature that doesn't exist, and dynamic `EXECUTE` to skip the
-- statement entirely rather than let it fail on a missing function.
SET ROLE dirus_tenant_resolver;
DO $$
BEGIN
  IF to_regprocedure('public.dirus_resolve_broker_id_by_email(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id_by_email(text) FROM PUBLIC';
  END IF;
  IF to_regprocedure('public.dirus_resolve_broker_id_by_magic_link(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id_by_magic_link(text) FROM PUBLIC';
  END IF;
  IF to_regprocedure('public.dirus_resolve_broker_id_by_session(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id_by_session(text) FROM PUBLIC';
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app') THEN
    IF to_regprocedure('public.dirus_resolve_broker_id_by_email(text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_email(text) TO dirus_app;
    END IF;
    IF to_regprocedure('public.dirus_resolve_broker_id_by_magic_link(text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_magic_link(text) TO dirus_app;
    END IF;
    IF to_regprocedure('public.dirus_resolve_broker_id_by_session(text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_session(text) TO dirus_app;
    END IF;
  END IF;
END
$$;
RESET ROLE;
--> statement-breakpoint

-- Step 6: move the column-scoped SELECT grant. Same migration as the
-- function change — mandatory, per proposal P3 and Risk row 1: if the
-- function shipped without this grant, it would filter on a column the
-- resolver role cannot read, and Postgres's "permission denied for column
-- chatwoot_account_id" is caught by `resolveBrokerIdByChatwootAccountId`
-- exactly like an empty result, surfacing as a routine
-- `tenant_resolution_miss` — a permissions defect wearing a miss's clothing,
-- the worst possible failure shape for this component. The only structural
-- defense is atomicity: this grant and the function above ship together.
--
-- Grant-new-before-revoke-old, not the reverse: the migration runner's
-- transaction boundary per statement chunk is not assumed here, so at no
-- intermediate point can the resolver role read *neither* column.
-- `GRANT SELECT (id, chatwoot_account_id)` is additive to the existing
-- `(id, wa_phone_number_id)` grant (0004), so the intermediate state is a
-- strict superset; the REVOKE then narrows it to exactly what Success
-- Criteria item 10 requires. `id` is re-granted rather than assumed —
-- column grants are per-column and re-granting an already-held column
-- privilege is a no-op, stated explicitly rather than depending on the
-- reader remembering 0004.
--
-- `wa_phone_number_id` is revoked, not left in place: after 0007 the
-- resolver role has no reason to see it. The column itself stays on
-- `brokers` (proposal Out of Scope) — only this role's reach into it is
-- removed.
GRANT  SELECT (id, chatwoot_account_id) ON public.brokers TO   dirus_tenant_resolver;
REVOKE SELECT (wa_phone_number_id)      ON public.brokers FROM dirus_tenant_resolver;

-- Down path (documented, not scripted — this migration sequence has no
-- down-migration runner; see 0004/0006's same convention). Order is
-- load-bearing and mirrors the up path in reverse.
--
-- CAVEAT (verbatim from the proposal's Rollback Plan — do not soften this):
-- this down path restores a state that has never accepted a single real
-- Chatwoot webhook. It is a way to un-break something else this change
-- touched, not a way to restore working ingress. 0007 writes and migrates
-- no data, so there is nothing to un-migrate.
--
--   GRANT  SELECT (id, wa_phone_number_id)   ON public.brokers TO   dirus_tenant_resolver;
--   REVOKE SELECT (chatwoot_account_id)      ON public.brokers FROM dirus_tenant_resolver;
--   REVOKE EXECUTE ON FUNCTION public.dirus_resolve_broker_id(integer) FROM dirus_app;
--   SET ROLE dirus_tenant_resolver;
--   DROP FUNCTION public.dirus_resolve_broker_id(integer);
--   RESET ROLE;
--   CREATE FUNCTION public.dirus_resolve_broker_id(p_key text) RETURNS uuid
--     LANGUAGE sql STABLE SECURITY DEFINER
--     SET search_path = ''
--   AS $$ SELECT id FROM public.brokers WHERE wa_phone_number_id = p_key $$;
--   GRANT CREATE ON SCHEMA public TO dirus_tenant_resolver;
--   ALTER FUNCTION public.dirus_resolve_broker_id(text) OWNER TO dirus_tenant_resolver;
--   REVOKE CREATE ON SCHEMA public FROM dirus_tenant_resolver;
--   REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(text) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id(text) TO dirus_app;
