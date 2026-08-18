-- design.md D-D/D-E: multi-tenant isolation via Row Level Security.
--
-- `FORCE ROW LEVEL SECURITY` extends enforcement to the table-owning role
-- (the migration-applying role, since ownership defaults to the role that
-- created the table). `ENABLE` alone exempts the owner, which would let the
-- very role that ran this migration silently bypass every policy below.
--
-- `USING` governs which existing rows are visible/modifiable; `WITH CHECK`
-- governs which rows a write is allowed to leave behind. A `USING`-only
-- policy still lets a transaction scoped to broker A INSERT a row carrying
-- `broker_id = B` (design.md D-D spec gap, surfaced not patched) — every
-- policy below therefore declares both clauses with the identical
-- predicate.
--
-- `current_setting('app.broker_id', true)` (2-arg form) returns NULL when
-- unset instead of raising `undefined_object`, so an unset session fails
-- closed to zero rows rather than erroring (design.md D-E). `nullif(..., '')`
-- guards the one residual hole: a session variable explicitly set to the
-- empty string would otherwise raise on `''::uuid`.
--
-- brokers is the tenant root and is keyed on `id`, not `broker_id`.
ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;
ALTER TABLE brokers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON brokers FOR ALL
  USING      (id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE broker_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broker_users FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policies FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE extractions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON extractions FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON renewals FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
