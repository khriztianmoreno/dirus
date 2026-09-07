-- design.md D-1: tenant resolution for a request that holds only a
-- `wa_phone_number_id` and has not yet learned its `broker_id`.
--
-- The existing `tenant_isolation` policy on `brokers` (0002) requires
-- `app.broker_id` to already be set — exactly what tenant resolution has not
-- happened yet. Widening `dirus_app`'s own access (a permissive policy
-- granted directly to it, or a column-level GRANT) would make every broker
-- readable to it on every query, since Postgres OR-combines multiple
-- permissive policies for the same command (data-model spec, "The tenant-
-- resolution mechanism does not expose arbitrary brokers rows"). Instead, a
-- dedicated NOLOGIN role owns a SECURITY DEFINER function that is the only
-- caller of a second, narrowly `TO`-scoped permissive policy; `dirus_app`
-- gains EXECUTE on the function, never membership in the role, and never a
-- direct grant on `brokers` itself.
--
-- Unlike `dirus_app` (0003/provision-app-role.sql), this role carries no
-- secret (NOLOGIN — it can never open a session) and is created directly in
-- this committed migration rather than a provisioning script.
CREATE ROLE dirus_tenant_resolver NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO dirus_tenant_resolver;
-- Column-scoped: the resolver role can see the lookup key and the id it
-- resolves to, never any other brokers column (name, waba_id, plan,
-- status, ...). This bounds the blast radius even if row-level access were
-- ever broadened for this role, which it is not below.
GRANT SELECT (id, wa_phone_number_id) ON public.brokers TO dirus_tenant_resolver;
--> statement-breakpoint

-- Additional to, and does not modify, 0002's `tenant_isolation` policy.
-- `tenant_isolation` has no `TO` clause (applies to every role, including
-- this one), so `dirus_tenant_resolver`'s effective SELECT access is the OR
-- of both policies — but `tenant_isolation` alone yields zero rows for a
-- session with no `app.broker_id` set, so `tenant_resolver_lookup` is what
-- actually grants this role's access to a live SECURITY DEFINER call. The
-- `TO` clause is the entire control: it must name only
-- `dirus_tenant_resolver`, never `dirus_app` or `public`, or this reopens
-- exactly the read-every-broker hole D-1 rejects (see design.md's options
-- table).
CREATE POLICY tenant_resolver_lookup ON public.brokers
  FOR SELECT TO dirus_tenant_resolver USING (true);
--> statement-breakpoint

-- SECURITY DEFINER runs the body as the function's OWNER (dirus_tenant_
-- resolver, set below), not the caller — that's what makes
-- `tenant_resolver_lookup` apply during the call even though the caller
-- (dirus_app) never matches its `TO` clause directly. Three ways this can be
-- built wrong, all guarded here:
--   1. An unpinned search_path lets a caller-created relation (e.g. a
--      pg_temp table, implicitly searched first) hijack an unqualified
--      reference inside the body. `SET search_path = ''` plus the
--      schema-qualified `public.brokers` reference is the real defense —
--      `pg_temp_N.brokers` can never match a schema-qualified name.
--   2. Returning anything but a bare `uuid` (a row, a record, a table) would
--      expose columns beyond `id` through this path.
--   3. Filtering on `status` would contradict the settled product decision
--      (proposal P5, data-model spec "Tenant Resolution Does Not Filter on
--      brokers.status") that a suspended broker's webhook traffic must
--      still resolve so it can be persisted and handled downstream. This
--      WHERE clause filters only on `wa_phone_number_id` — do not add a
--      status predicate here without a new product decision revisiting P5.
CREATE FUNCTION public.dirus_resolve_broker_id(p_key text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$ SELECT id FROM public.brokers WHERE wa_phone_number_id = p_key $$;
--> statement-breakpoint

-- `ALTER FUNCTION ... OWNER TO` requires the migration role to hold
-- membership in the target role. `WITH INHERIT FALSE` (Postgres >= 16) is
-- load-bearing: RLS policy `TO`-clause matching uses `has_privs_of_role`,
-- which follows INHERIT membership. An *inheriting* membership of the
-- migration role (or, far worse, of `dirus_app`) into `dirus_tenant_
-- resolver` would make `tenant_resolver_lookup` apply directly to that
-- role's own sessions, fully reopening unrestricted `brokers` read access
-- without touching the policy or the function at all. This grant exists
-- solely so the next statement's `OWNER TO` succeeds, and is deliberately
-- non-inheriting so it confers no standing privilege.
GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;
-- Postgres additionally requires the NEW owner to hold CREATE on the
-- function's schema at the moment of transfer (undocumented until you hit
-- it: "the new owner must have CREATE privilege on the object's schema" —
-- true for every non-superuser migration role, which is every real Neon
-- connection; only bypassed when the role running this migration happens
-- to be an actual Postgres superuser, as CI's ephemeral container is,
-- which is why this never surfaced there). `dirus_tenant_resolver` is
-- meant to hold only USAGE (line 20) — CREATE is granted here only long
-- enough for the ALTER OWNER below, then immediately revoked so the
-- role's standing privilege set matches its documented minimal shape.
GRANT CREATE ON SCHEMA public TO dirus_tenant_resolver;
ALTER FUNCTION public.dirus_resolve_broker_id(text) OWNER TO dirus_tenant_resolver;
REVOKE CREATE ON SCHEMA public FROM dirus_tenant_resolver;
--> statement-breakpoint

-- Functions grant EXECUTE to PUBLIC by default — this REVOKE is load-
-- bearing, not decoration. The GRANT below is guarded by a `pg_roles`
-- existence check, mirroring 0003_app_role_grants.sql's pattern, so a fresh
-- clone (dirus_app not yet provisioned) migrates cleanly.
REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app') THEN
    GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id(text) TO dirus_app;
  END IF;
END
$$;

-- Down path (documented, not scripted as a separate file — this migration
-- sequence has no down-migration runner; see design.md "Migration /
-- Rollout"). Order is load-bearing: dropping the role before the function
-- it owns fails, and the function's OWNER TO membership grant must be
-- revoked only after the function itself is gone.
--
--   REVOKE EXECUTE ON FUNCTION public.dirus_resolve_broker_id(text) FROM dirus_app;
--   DROP FUNCTION public.dirus_resolve_broker_id(text);
--   DROP POLICY tenant_resolver_lookup ON public.brokers;
--   REVOKE SELECT (id, wa_phone_number_id) ON public.brokers FROM dirus_tenant_resolver;
--   REVOKE USAGE ON SCHEMA public FROM dirus_tenant_resolver;
--   REVOKE dirus_tenant_resolver FROM <the role that ran this migration>;
--   DROP ROLE dirus_tenant_resolver;
