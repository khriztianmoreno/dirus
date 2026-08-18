-- design.md D-F: grant statements for the least-privilege application
-- role. Wrapped in a `DO` block guarded by a `pg_roles` existence check so
-- a fresh clone (no `dirus_app` role yet) migrates cleanly — the role
-- itself is a documented one-time operational step
-- (`packages/db/scripts/provision-app-role.sql`), never created here,
-- because it carries secret material (a password) and is
-- Neon-account-scoped.
--
-- "Do not overstate" (design.md D-F): `FORCE ROW LEVEL SECURITY` (0002)
-- already binds the table owner, so RLS functions without this role.
-- `dirus_app` is defense in depth against an accidentally granted
-- `BYPASSRLS`, nothing more.
--
-- Judgment Day round 1: deliberately does NOT run
-- `ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES`. That statement would
-- auto-grant `dirus_app` full CRUD on every table created *after* this
-- migration runs, regardless of whether that table's own migration also
-- remembers the `ENABLE`/`FORCE ROW LEVEL SECURITY`/`CREATE POLICY` block
-- from 0002's pattern. Coupling an automatic grant to a manual protection
-- step is exactly backwards for multi-tenant isolation: if a future
-- migration forgets the RLS block, an automatic default-privileges grant
-- fails OPEN (silent cross-tenant read/write) instead of failing closed. By
-- requiring every new tenant table's migration to re-run this same explicit
-- `GRANT ... ON ALL TABLES IN SCHEMA public` shape alongside its RLS setup,
-- a forgotten grant instead fails LOUD — the app simply cannot read the new
-- table at all, a visible bug rather than a silent breach.
-- `test/migrations/rls-catalog-guard.test.ts` is the compensating,
-- catalog-derived control that still catches a forgotten RLS block even
-- when the grant itself is present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app') THEN
    GRANT USAGE ON SCHEMA public TO dirus_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dirus_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dirus_app;
  END IF;
END
$$;
