import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * design.md D-D: structural SQL-text assertions for
 * `0007_chatwoot_account_resolution.sql`, mirroring
 * `tenant-resolver-migration.test.ts`'s convention for `0004`
 * (design.md D-G: "keep `0004`'s file verbatim, add a sibling for `0007`").
 * This proves the migration *declares* the right SQL, in the right order;
 * it cannot prove Postgres actually *enforces* it, or that a non-superuser
 * role can really run the `SET ROLE`-to-drop sequence (design.md D-C,
 * status NEEDS EMPIRICAL PROOF) — that is task 1.5's job, against a real
 * database, never by text inspection alone.
 *
 * Task 1.1 (tasks.md): this test was authored, and observed RED against a
 * not-yet-existing `0007_chatwoot_account_resolution.sql`, before the
 * migration file was written.
 */
const migrationPath = fileURLToPath(new URL("../../migrations/0007_chatwoot_account_resolution.sql", import.meta.url));
const sql = readFileSync(migrationPath, "utf8");

describe("0007_chatwoot_account_resolution.sql", () => {
  it("re-grants dirus_tenant_resolver membership WITH INHERIT FALSE before anything else depends on it", () => {
    const grantIndex = sql.indexOf("GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;");
    expect(grantIndex).toBeGreaterThan(-1);
  });

  it("drops the old (text) signature via SET ROLE / DROP FUNCTION / RESET ROLE, no CASCADE, no IF EXISTS", () => {
    const setRoleIndex = sql.indexOf("SET ROLE dirus_tenant_resolver;");
    const dropIndex = sql.indexOf("DROP FUNCTION public.dirus_resolve_broker_id(text);");
    const resetRoleIndex = sql.indexOf("RESET ROLE;");
    expect(setRoleIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(setRoleIndex);
    expect(resetRoleIndex).toBeGreaterThan(dropIndex);
    expect(sql).not.toMatch(/DROP FUNCTION public\.dirus_resolve_broker_id\(text\)\s+CASCADE/);
    expect(sql).not.toMatch(/DROP FUNCTION IF EXISTS public\.dirus_resolve_broker_id\(text\)/);
  });

  it("orders the membership grant before the drop, and the drop before the create", () => {
    const grantIndex = sql.indexOf("GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;");
    const dropIndex = sql.indexOf("DROP FUNCTION public.dirus_resolve_broker_id(text);");
    const createIndex = sql.indexOf("CREATE FUNCTION public.dirus_resolve_broker_id(p_account_id integer) RETURNS uuid");
    expect(grantIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(grantIndex);
    expect(createIndex).toBeGreaterThan(dropIndex);
  });

  it("declares the new resolver function as SECURITY DEFINER with a pinned empty search_path, keyed on chatwoot_account_id", () => {
    expect(sql).toMatch(/CREATE FUNCTION public\.dirus_resolve_broker_id\(p_account_id integer\) RETURNS uuid/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = ''/);
    expect(sql).toMatch(/SELECT id FROM public\.brokers WHERE chatwoot_account_id = p_account_id/);
  });

  it("does not filter on brokers.status anywhere in the new function body (settled product decision P5)", () => {
    const bodyMatch = sql.match(/AS \$\$([\s\S]*?)\$\$;/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1]).not.toMatch(/status/i);
  });

  it("brackets ownership transfer with a temporary GRANT/REVOKE CREATE ON SCHEMA public, transferring to dirus_tenant_resolver", () => {
    const createIndex = sql.indexOf("CREATE FUNCTION public.dirus_resolve_broker_id(p_account_id integer) RETURNS uuid");
    const grantSchemaIndex = sql.indexOf("GRANT CREATE ON SCHEMA public TO dirus_tenant_resolver;");
    const alterOwnerIndex = sql.indexOf("ALTER FUNCTION public.dirus_resolve_broker_id(integer) OWNER TO dirus_tenant_resolver;");
    const revokeSchemaIndex = sql.indexOf("REVOKE CREATE ON SCHEMA public FROM dirus_tenant_resolver;");
    expect(createIndex).toBeGreaterThan(-1);
    expect(grantSchemaIndex).toBeGreaterThan(createIndex);
    expect(alterOwnerIndex).toBeGreaterThan(grantSchemaIndex);
    expect(revokeSchemaIndex).toBeGreaterThan(alterOwnerIndex);
  });

  it("revokes PUBLIC's default EXECUTE strictly before granting EXECUTE to dirus_app", () => {
    const revokeIndex = sql.indexOf("REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(integer) FROM PUBLIC;");
    const grantIndex = sql.indexOf("GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id(integer) TO dirus_app;");
    expect(revokeIndex).toBeGreaterThan(-1);
    expect(grantIndex).toBeGreaterThan(revokeIndex);
  });

  it("wraps the EXECUTE-privilege REVOKE/GRANT in SET ROLE / RESET ROLE (task 1.5 live finding: REVOKE fails silently, not loudly, without it)", () => {
    const setRoleIndex = sql.lastIndexOf(
      "SET ROLE dirus_tenant_resolver;",
      sql.indexOf("REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(integer) FROM PUBLIC;"),
    );
    const revokeIndex = sql.indexOf("REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(integer) FROM PUBLIC;");
    const resetRoleIndex = sql.indexOf("RESET ROLE;", revokeIndex);
    expect(setRoleIndex).toBeGreaterThan(-1);
    expect(revokeIndex).toBeGreaterThan(setRoleIndex);
    expect(resetRoleIndex).toBeGreaterThan(revokeIndex);
  });

  it("step 5b: re-applies REVOKE ALL FROM PUBLIC, under SET ROLE, for all three 0006 functions (live finding: 0006's own REVOKE silently no-op'd for the same reason)", () => {
    for (const fn of [
      "dirus_resolve_broker_id_by_email(text)",
      "dirus_resolve_broker_id_by_magic_link(text)",
      "dirus_resolve_broker_id_by_session(text)",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO dirus_app;`);
    }
    const step5bStart = sql.indexOf("REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id_by_email(text) FROM PUBLIC;");
    const setRoleBefore = sql.lastIndexOf("SET ROLE dirus_tenant_resolver;", step5bStart);
    const resetRoleAfter = sql.indexOf("RESET ROLE;", step5bStart);
    expect(setRoleBefore).toBeGreaterThan(-1);
    expect(resetRoleAfter).toBeGreaterThan(step5bStart);
  });

  it("guards the dirus_app EXECUTE grant behind a pg_roles existence check (fresh clone migrates cleanly)", () => {
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app'\) THEN/);
  });

  it("moves the column-scoped SELECT grant: grants (id, chatwoot_account_id) before revoking (wa_phone_number_id)", () => {
    const grantColIndex = sql.indexOf("GRANT  SELECT (id, chatwoot_account_id) ON public.brokers TO   dirus_tenant_resolver;");
    const revokeColIndex = sql.indexOf("REVOKE SELECT (wa_phone_number_id)      ON public.brokers FROM dirus_tenant_resolver;");
    expect(grantColIndex).toBeGreaterThan(-1);
    expect(revokeColIndex).toBeGreaterThan(grantColIndex);
  });

  it("documents (not scripts) a down path restoring the old (text) signature", () => {
    const lines = sql.split("\n").filter((line) => line.trimStart().startsWith("--"));
    const commentBlock = lines.join("\n");
    expect(commentBlock).toMatch(/CREATE FUNCTION public\.dirus_resolve_broker_id\(p_key text\) RETURNS uuid/);
    expect(sql).not.toMatch(/^\s*CREATE FUNCTION public\.dirus_resolve_broker_id\(p_key text\) RETURNS uuid/m);
  });
});
