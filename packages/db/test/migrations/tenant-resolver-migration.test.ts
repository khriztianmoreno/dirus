import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * design.md D-1: structural SQL-text assertions for
 * `0004_tenant_resolver.sql`, mirroring `rls-policies.test.ts`'s and
 * `app-role-grants.test.ts`'s convention. This proves the migration
 * *declares* the right SQL; it cannot prove Postgres actually *enforces*
 * it — that is `live-tenant-resolution.test.ts`'s job, and per data-model
 * spec ("Testing Strategy") the negative-control and owner-control
 * scenarios MUST be proven live, never by text inspection alone.
 *
 * Tasks 1.1/1.2 (tasks.md): this test was authored, and observed RED
 * against an empty custom-migration stub (`-- Custom SQL migration file,
 * put your code below! --`), before the migration content below was
 * written — see apply-progress.md for the record of that RED run.
 */
const migrationPath = fileURLToPath(new URL("../../migrations/0004_tenant_resolver.sql", import.meta.url));
const sql = readFileSync(migrationPath, "utf8");

describe("0004_tenant_resolver.sql", () => {
  it("declares the resolver role as NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE", () => {
    expect(sql).toMatch(
      /CREATE ROLE dirus_tenant_resolver NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;/,
    );
  });

  it("never grants LOGIN to the resolver role (it must never be a connection identity)", () => {
    expect(sql).not.toMatch(/dirus_tenant_resolver\s+(?:WITH\s+)?LOGIN/i);
  });

  it("scopes the permissive brokers lookup policy's TO clause to only dirus_tenant_resolver", () => {
    expect(sql).toMatch(
      /CREATE POLICY tenant_resolver_lookup ON public\.brokers\s+FOR SELECT TO dirus_tenant_resolver USING \(true\);/,
    );
  });

  it("declares the resolver function as SECURITY DEFINER with a pinned empty search_path", () => {
    expect(sql).toMatch(/CREATE FUNCTION public\.dirus_resolve_broker_id\(p_key text\) RETURNS uuid/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = ''/);
  });

  it("schema-qualifies the brokers reference inside the function body (guards the search_path hijack)", () => {
    expect(sql).toMatch(/SELECT id FROM public\.brokers WHERE wa_phone_number_id = p_key/);
  });

  it("owns the function by the resolver role, never the table owner", () => {
    expect(sql).toMatch(/ALTER FUNCTION public\.dirus_resolve_broker_id\(text\) OWNER TO dirus_tenant_resolver;/);
  });

  it("grants the OWNER TO membership WITH INHERIT FALSE (the has_privs_of_role guard)", () => {
    expect(sql).toMatch(/GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;/);
  });

  it("revokes PUBLIC's default EXECUTE, then grants EXECUTE only to dirus_app", () => {
    const revokeIndex = sql.indexOf("REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(text) FROM PUBLIC;");
    const grantIndex = sql.indexOf("GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id(text) TO dirus_app;");
    expect(revokeIndex).toBeGreaterThan(-1);
    expect(grantIndex).toBeGreaterThan(-1);
    expect(grantIndex).toBeGreaterThan(revokeIndex);
  });

  it("guards the dirus_app EXECUTE grant behind a pg_roles existence check (fresh clone migrates cleanly)", () => {
    // Mirrors 0003_app_role_grants.sql's DO-block guard: dirus_app may not
    // exist yet on a fresh clone (it is provisioned separately, per
    // scripts/provision-app-role.sql), so this migration must not
    // unconditionally assume it does.
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app'\) THEN/);
  });

  it("never creates the dirus_app role itself (password material stays out of the migration)", () => {
    expect(sql).not.toMatch(/CREATE ROLE dirus_app/);
  });

  it("does not filter on brokers.status anywhere in the function body (settled product decision P5)", () => {
    const bodyMatch = sql.match(/AS \$\$([\s\S]*?)\$\$;/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1]).not.toMatch(/status/i);
  });

  it("returns a bare uuid, never a row/record/table type", () => {
    expect(sql).toMatch(/RETURNS uuid/);
    expect(sql).not.toMatch(/RETURNS TABLE/i);
    expect(sql).not.toMatch(/RETURNS SETOF/i);
    expect(sql).not.toMatch(/RETURNS record/i);
  });

  it("documents the down path in the order design.md's 'Migration / Rollout' specifies", () => {
    const revokeExecuteIdx = sql.indexOf("REVOKE EXECUTE ON FUNCTION public.dirus_resolve_broker_id(text) FROM dirus_app;");
    const dropFunctionIdx = sql.indexOf("DROP FUNCTION public.dirus_resolve_broker_id(text);");
    const dropPolicyIdx = sql.indexOf("DROP POLICY tenant_resolver_lookup ON public.brokers;");
    const dropRoleIdx = sql.indexOf("DROP ROLE dirus_tenant_resolver;");
    expect(revokeExecuteIdx).toBeGreaterThan(-1);
    expect(dropFunctionIdx).toBeGreaterThan(revokeExecuteIdx);
    expect(dropPolicyIdx).toBeGreaterThan(dropFunctionIdx);
    expect(dropRoleIdx).toBeGreaterThan(dropPolicyIdx);
  });
});
