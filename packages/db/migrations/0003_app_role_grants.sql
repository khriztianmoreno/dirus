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
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app') THEN
    GRANT USAGE ON SCHEMA public TO dirus_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dirus_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dirus_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dirus_app;
  END IF;
END
$$;
