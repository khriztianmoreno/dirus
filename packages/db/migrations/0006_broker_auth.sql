-- admin-dashboard (C1), design.md D-A/D-H (status: NEEDS EMPIRICAL PROOF —
-- see test/migrations/live-broker-auth.test.ts's five live assertions,
-- tasks.md Phase 1). Drizzle-generated table/column/FK DDL (from
-- src/schema/{broker_users,magic_link_tokens,sessions}.ts) plus hand-written
-- RLS + SECURITY DEFINER sections below, mirroring 0004_tenant_resolver.sql
-- (the resolver-function pattern) and 0002_rls_policies.sql (the RLS shape)
-- exactly, per `drizzle-kit generate --custom` convention already used by
-- both.
CREATE TABLE "magic_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"broker_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_id" uuid NOT NULL,
	"broker_user_id" uuid NOT NULL,
	"session_token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);
--> statement-breakpoint
ALTER TABLE "broker_users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_broker_user_id_broker_users_id_fk" FOREIGN KEY ("broker_user_id") REFERENCES "public"."broker_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_broker_user_id_broker_users_id_fk" FOREIGN KEY ("broker_user_id") REFERENCES "public"."broker_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_broker_user_id_index" ON "sessions" USING btree ("broker_user_id");--> statement-breakpoint

-- design.md D-H: a PLAIN unique index, deliberately NOT `UNIQUE (broker_id,
-- email)` and deliberately NOT `NULLS NOT DISTINCT`. Postgres already treats
-- every NULL as distinct in a plain unique index, so unlimited existing
-- WhatsApp-only rows may keep `email IS NULL` (P2); `NULLS NOT DISTINCT`
-- would collapse them into one row on the second insert. Written as
-- `CREATE UNIQUE INDEX`, mirroring 0005_policy_number_unique_index.sql's
-- form, rather than the `ADD CONSTRAINT ... UNIQUE` shape `drizzle-kit`
-- generates by default — both produce an equivalent index, but the CREATE
-- UNIQUE INDEX form is this repo's established convention for a
-- hand-reasoned-about index shape (see test/migrations/broker-auth-migration.test.ts).
CREATE UNIQUE INDEX "broker_users_email_key" ON public.broker_users ("email");
--> statement-breakpoint

-- design.md D-A: extends 0004_tenant_resolver.sql's `dirus_tenant_resolver`
-- role to three new key→uuid lookups needed before `broker_id` is known:
-- email → user (link request), token hash → user (callback), session hash →
-- user (every request). NO `CREATE ROLE` here — 0004 already created it.
--
-- Column-scoped grants: the resolver role sees only the lookup key and the
-- ids it needs to resolve, never any other column (name, phone, role on
-- broker_users; nothing else on the two new tables).
GRANT SELECT (id, broker_id, email)          ON public.broker_users      TO dirus_tenant_resolver;
GRANT SELECT (broker_id, token_hash)         ON public.magic_link_tokens TO dirus_tenant_resolver;
GRANT SELECT (broker_id, session_token_hash) ON public.sessions          TO dirus_tenant_resolver;
--> statement-breakpoint

-- RLS, identical shape to 0002_rls_policies.sql: FORCE (not ENABLE alone)
-- binds the table-owning role too, and both USING/WITH CHECK carry the
-- identical predicate — a USING-only policy would let a broker-A
-- transaction insert a broker-B row (design.md D-H).
ALTER TABLE magic_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_link_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON magic_link_tokens FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

-- Additional to, and does not modify, the `tenant_isolation` policies above.
-- Each has no `TO` clause (applies to every role), so `dirus_tenant_
-- resolver`'s effective SELECT access is the OR of both policies — but
-- `tenant_isolation` alone yields zero rows for a session with no
-- `app.broker_id` set, so `tenant_resolver_lookup` is what actually grants
-- this role's access to a live SECURITY DEFINER call. The `TO` clause is the
-- entire control: it must name only `dirus_tenant_resolver`, never
-- `dirus_app` or `public` (0004_tenant_resolver.sql's same reasoning,
-- verified live by test/migrations/live-broker-auth.test.ts's assertion 4).
CREATE POLICY tenant_resolver_lookup ON public.broker_users
  FOR SELECT TO dirus_tenant_resolver USING (true);
--> statement-breakpoint

CREATE POLICY tenant_resolver_lookup ON public.magic_link_tokens
  FOR SELECT TO dirus_tenant_resolver USING (true);
--> statement-breakpoint

CREATE POLICY tenant_resolver_lookup ON public.sessions
  FOR SELECT TO dirus_tenant_resolver USING (true);
--> statement-breakpoint

-- SECURITY DEFINER runs the body as the function's OWNER (dirus_tenant_
-- resolver, set below), not the caller. `SET search_path = ''` plus the
-- schema-qualified `public.<table>` reference in each body is the
-- search_path-hijack defense (0004's identical reasoning): an unpinned
-- search_path would let a caller-created relation (e.g. a pg_temp table,
-- implicitly searched first) hijack an unqualified reference inside the
-- body.
--
-- The functions decide nothing (design.md D-A): they filter ONLY on the key
-- (email / token_hash / session_token_hash) — no `expires_at`, no `used_at`,
-- no `revoked_at`. Expiry, single-use consumption, and idle timeout are all
-- evaluated inside `withBrokerContext`, under RLS, in the same transaction
-- that mutates the row — not split across two connections. Each returns a
-- bare `uuid`, never a row/record/table type, keeping the same invariant
-- 0004's `dirus_resolve_broker_id` established.
CREATE FUNCTION public.dirus_resolve_broker_id_by_email(p_email text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$ SELECT broker_id FROM public.broker_users WHERE email = p_email $$;
--> statement-breakpoint

CREATE FUNCTION public.dirus_resolve_broker_id_by_magic_link(p_token_hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$ SELECT broker_id FROM public.magic_link_tokens WHERE token_hash = p_token_hash $$;
--> statement-breakpoint

CREATE FUNCTION public.dirus_resolve_broker_id_by_session(p_session_hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$ SELECT broker_id FROM public.sessions WHERE session_token_hash = p_session_hash $$;
--> statement-breakpoint

-- `ALTER FUNCTION ... OWNER TO` requires the migration role to hold
-- membership in the target role. `WITH INHERIT FALSE` (Postgres >= 16) is
-- load-bearing for the same reason as 0004: RLS policy `TO`-clause matching
-- uses `has_privs_of_role`, which follows INHERIT membership, so an
-- *inheriting* membership here would make `tenant_resolver_lookup` apply
-- directly to the migration role's (or dirus_app's) own sessions. This grant
-- exists solely so the next three `OWNER TO` statements succeed, and confers
-- no standing privilege.
GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;
-- Same gap 0004 documents: Postgres also requires the NEW owner to hold
-- CREATE on the schema at the moment of transfer, which `dirus_tenant_
-- resolver` never holds standingly (only USAGE) — bracket the three OWNER
-- TO statements with a temporary CREATE grant, then revoke it immediately
-- after so the role's privilege set returns to its documented minimal
-- shape.
GRANT CREATE ON SCHEMA public TO dirus_tenant_resolver;
ALTER FUNCTION public.dirus_resolve_broker_id_by_email(text) OWNER TO dirus_tenant_resolver;
ALTER FUNCTION public.dirus_resolve_broker_id_by_magic_link(text) OWNER TO dirus_tenant_resolver;
ALTER FUNCTION public.dirus_resolve_broker_id_by_session(text) OWNER TO dirus_tenant_resolver;
REVOKE CREATE ON SCHEMA public FROM dirus_tenant_resolver;
--> statement-breakpoint

-- Functions grant EXECUTE to PUBLIC by default — these REVOKEs are load-
-- bearing, not decoration. The GRANTs below are guarded by a `pg_roles`
-- existence check, mirroring 0003_app_role_grants.sql's / 0004's pattern, so
-- a fresh clone (dirus_app not yet provisioned) migrates cleanly.
REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id_by_magic_link(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id_by_session(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app') THEN
    GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_email(text) TO dirus_app;
    GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_magic_link(text) TO dirus_app;
    GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_session(text) TO dirus_app;
  END IF;
END
$$;

-- Down path (documented, not scripted as a separate file — this migration
-- sequence has no down-migration runner; see 0004_tenant_resolver.sql's same
-- convention). Order is load-bearing, per design.md D-H: revoke EXECUTE ->
-- drop functions -> drop policies -> revoke column grants -> drop tables ->
-- drop the email index and column. `dirus_tenant_resolver` itself is NOT
-- dropped — 0004 owns it.
--
--   REVOKE EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_email(text) FROM dirus_app;
--   REVOKE EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_magic_link(text) FROM dirus_app;
--   REVOKE EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_session(text) FROM dirus_app;
--   DROP FUNCTION public.dirus_resolve_broker_id_by_email(text);
--   DROP FUNCTION public.dirus_resolve_broker_id_by_magic_link(text);
--   DROP FUNCTION public.dirus_resolve_broker_id_by_session(text);
--   DROP POLICY tenant_resolver_lookup ON public.broker_users;
--   DROP POLICY tenant_resolver_lookup ON public.magic_link_tokens;
--   DROP POLICY tenant_resolver_lookup ON public.sessions;
--   DROP POLICY tenant_isolation ON public.magic_link_tokens;
--   DROP POLICY tenant_isolation ON public.sessions;
--   REVOKE SELECT (id, broker_id, email) ON public.broker_users FROM dirus_tenant_resolver;
--   REVOKE SELECT (broker_id, token_hash) ON public.magic_link_tokens FROM dirus_tenant_resolver;
--   REVOKE SELECT (broker_id, session_token_hash) ON public.sessions FROM dirus_tenant_resolver;
--   REVOKE dirus_tenant_resolver FROM <the role that ran this migration>;
--   DROP TABLE public.magic_link_tokens;
--   DROP TABLE public.sessions;
--   DROP INDEX public.broker_users_email_key;
--   ALTER TABLE public.broker_users DROP COLUMN email;
