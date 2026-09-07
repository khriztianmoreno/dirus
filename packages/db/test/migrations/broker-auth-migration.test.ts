import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `admin-dashboard` (C1), design.md D-A/D-H (status: NEEDS EMPIRICAL PROOF):
 * structural SQL-text assertions for `0006_broker_auth.sql`, mirroring
 * `tenant-resolver-migration.test.ts`'s and `policy-number-unique-index.test.ts`'s
 * convention. This proves the migration *declares* the right SQL; it cannot
 * prove Postgres actually *enforces* it — that is
 * `live-broker-auth.test.ts`'s job, and per design D-A the five live
 * assertions (positive, negative control, miss, catalog guard, cross-tenant)
 * MUST be proven live, never by text inspection alone.
 *
 * Task 1.1 (tasks.md): this test was authored, and observed RED against the
 * pre-existing migration set (no `0006_broker_auth.sql` file at all — the
 * `readFileSync` call itself throws `ENOENT`), before the migration content
 * below was written. See apply-progress.md for the record of that RED run.
 */
const migrationPath = fileURLToPath(new URL("../../migrations/0006_broker_auth.sql", import.meta.url));
const sql = readFileSync(migrationPath, "utf8");

describe("0006_broker_auth.sql", () => {
  it("adds a nullable email column to broker_users", () => {
    expect(sql).toMatch(/ALTER TABLE (?:"|)broker_users(?:"|) ADD COLUMN (?:"|)email(?:"|) text/);
  });

  it("declares a PLAIN unique index on broker_users.email, not scoped by broker_id", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX (?:"|)broker_users_email_key(?:"|) ON public\.broker_users \((?:"|)email(?:"|)\)/,
    );
  });

  it("does NOT use NULLS NOT DISTINCT on the email index (would break every existing row on the second insert)", () => {
    const indexLine = sql.match(/CREATE UNIQUE INDEX[^\n]*broker_users_email_key[^\n]*\n/);
    expect(indexLine).not.toBeNull();
    expect(indexLine![0]).not.toMatch(/NULLS NOT DISTINCT/i);
  });

  it("does NOT scope the email index by broker_id (uniqueness is global per O2)", () => {
    const indexLine = sql.match(/CREATE UNIQUE INDEX[^\n]*broker_users_email_key[^\n]*\n/);
    expect(indexLine).not.toBeNull();
    expect(indexLine![0]).not.toMatch(/broker_id/);
  });

  it("creates magic_link_tokens with RLS enabled and forced", () => {
    expect(sql).toMatch(/CREATE TABLE (?:"|)magic_link_tokens(?:"|)/);
    expect(sql).toMatch(/ALTER TABLE (?:"|)magic_link_tokens(?:"|) ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE (?:"|)magic_link_tokens(?:"|) FORCE ROW LEVEL SECURITY/);
  });

  it("creates sessions with RLS enabled and forced", () => {
    expect(sql).toMatch(/CREATE TABLE (?:"|)sessions(?:"|)/);
    expect(sql).toMatch(/ALTER TABLE (?:"|)sessions(?:"|) ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE (?:"|)sessions(?:"|) FORCE ROW LEVEL SECURITY/);
  });

  function extractPolicyClauses(table: string): { using: string; withCheck: string } {
    const start = sql.indexOf(`CREATE POLICY tenant_isolation ON ${table} FOR ALL`);
    expect(start).toBeGreaterThan(-1);
    const end = sql.indexOf(";", start);
    const block = sql.slice(start, end);
    const usingMatch = block.match(/USING\s+\(([\s\S]+)\)\s*\n\s*WITH CHECK/);
    const checkMatch = block.match(/WITH CHECK\s+\(([\s\S]+)\)\s*$/);
    expect(usingMatch).not.toBeNull();
    expect(checkMatch).not.toBeNull();
    return { using: usingMatch![1].trim(), withCheck: checkMatch![1].trim() };
  }

  it("declares identical USING and WITH CHECK predicates on magic_link_tokens' tenant_isolation policy", () => {
    const { using, withCheck } = extractPolicyClauses("magic_link_tokens");
    expect(using).toBe(withCheck);
  });

  it("declares identical USING and WITH CHECK predicates on sessions' tenant_isolation policy", () => {
    const { using, withCheck } = extractPolicyClauses("sessions");
    expect(using).toBe(withCheck);
  });

  it("declares the three resolver functions, each SECURITY DEFINER with a non-null pinned search_path", () => {
    for (const fn of [
      "dirus_resolve_broker_id_by_email",
      "dirus_resolve_broker_id_by_magic_link",
      "dirus_resolve_broker_id_by_session",
    ]) {
      const fnRegex = new RegExp(`CREATE FUNCTION public\\.${fn}\\([^)]*\\) RETURNS uuid`);
      expect(sql).toMatch(fnRegex);
    }
    // Every resolver function pins search_path — count must match the
    // function count (3), not just "at least one".
    const searchPathMatches = sql.match(/SET search_path = ''/g) ?? [];
    expect(searchPathMatches.length).toBeGreaterThanOrEqual(3);
    const secdefMatches = sql.match(/SECURITY DEFINER/g) ?? [];
    expect(secdefMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("none of the three resolver functions filter on expires_at, used_at, or revoked_at (the functions decide nothing, D-A)", () => {
    const bodies = [...sql.matchAll(/AS \$\$([\s\S]*?)\$\$;/g)].map((m) => m[1]);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of bodies) {
      expect(body).not.toMatch(/expires_at|used_at|revoked_at/i);
    }
  });

  it("owns all three resolver functions by dirus_tenant_resolver and revokes EXECUTE from PUBLIC", () => {
    for (const fn of [
      "dirus_resolve_broker_id_by_email(text)",
      "dirus_resolve_broker_id_by_magic_link(text)",
      "dirus_resolve_broker_id_by_session(text)",
    ]) {
      expect(sql).toMatch(new RegExp(`ALTER FUNCTION public\\.${fn.replace(/[()]/g, "\\$&")} OWNER TO dirus_tenant_resolver;`));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn.replace(/[()]/g, "\\$&")} FROM PUBLIC;`));
    }
  });

  it("does NOT create the dirus_tenant_resolver role again (0004 already owns it)", () => {
    expect(sql).not.toMatch(/CREATE ROLE dirus_tenant_resolver/);
  });

  it("grants SELECT on only the narrow columns design D-A names, to dirus_tenant_resolver", () => {
    expect(sql).toMatch(/GRANT SELECT \(id, broker_id, email\)\s+ON public\.broker_users\s+TO dirus_tenant_resolver;/);
    expect(sql).toMatch(
      /GRANT SELECT \(broker_id, token_hash\)\s+ON public\.magic_link_tokens\s+TO dirus_tenant_resolver;/,
    );
    expect(sql).toMatch(
      /GRANT SELECT \(broker_id, session_token_hash\)\s+ON public\.sessions\s+TO dirus_tenant_resolver;/,
    );
  });

  it("scopes each new tenant_resolver_lookup policy's TO clause to only dirus_tenant_resolver", () => {
    for (const table of ["broker_users", "magic_link_tokens", "sessions"]) {
      expect(sql).toMatch(
        new RegExp(`CREATE POLICY tenant_resolver_lookup ON public\\.${table}\\s+FOR SELECT TO dirus_tenant_resolver USING \\(true\\);`),
      );
    }
  });

  it("documents the down path in the order design.md D-H specifies", () => {
    const revokeExecuteIdx = sql.indexOf("REVOKE EXECUTE ON FUNCTION public.dirus_resolve_broker_id_by_email(text) FROM dirus_app;");
    const dropFunctionIdx = sql.indexOf("DROP FUNCTION public.dirus_resolve_broker_id_by_email(text);");
    const dropPolicyIdx = sql.indexOf("DROP POLICY tenant_resolver_lookup ON public.broker_users;");
    const revokeColumnIdx = sql.indexOf("REVOKE SELECT (id, broker_id, email) ON public.broker_users FROM dirus_tenant_resolver;");
    const dropTableIdx = sql.indexOf("DROP TABLE public.sessions;");
    const dropIndexIdx = sql.indexOf("DROP INDEX public.broker_users_email_key;");
    expect(revokeExecuteIdx).toBeGreaterThan(-1);
    expect(dropFunctionIdx).toBeGreaterThan(revokeExecuteIdx);
    expect(dropPolicyIdx).toBeGreaterThan(dropFunctionIdx);
    expect(revokeColumnIdx).toBeGreaterThan(dropPolicyIdx);
    expect(dropTableIdx).toBeGreaterThan(revokeColumnIdx);
    expect(dropIndexIdx).toBeGreaterThan(dropTableIdx);
  });

  it("never drops dirus_tenant_resolver itself (0004 owns the role)", () => {
    expect(sql).not.toMatch(/DROP ROLE dirus_tenant_resolver/);
  });
});
