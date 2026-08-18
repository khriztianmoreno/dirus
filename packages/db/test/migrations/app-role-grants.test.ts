import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * design.md D-F: the migration sequence grants least-privilege access to
 * `dirus_app`, guarded by a `pg_roles` existence check so a fresh clone
 * (role not yet provisioned) migrates cleanly. `CREATE ROLE` itself is
 * deliberately NOT here — it carries a password and is a one-time
 * operational step (`packages/db/scripts/provision-app-role.sql`).
 */
const migrationPath = fileURLToPath(new URL("../../migrations/0003_app_role_grants.sql", import.meta.url));
const sql = readFileSync(migrationPath, "utf8");

describe("0003_app_role_grants.sql", () => {
  it("guards every grant behind a pg_roles existence check (no-ops on a fresh clone)", () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app'\) THEN/);
  });

  it("never creates the role itself (password material stays out of the migration)", () => {
    expect(sql).not.toMatch(/CREATE ROLE/i);
  });

  it("grants schema usage, table CRUD, and sequence access to dirus_app", () => {
    expect(sql).toMatch(/GRANT USAGE ON SCHEMA public TO dirus_app;/);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dirus_app;/);
    expect(sql).toMatch(/GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dirus_app;/);
  });

  it("applies default privileges so future tables are covered without a manual re-grant", () => {
    expect(sql).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dirus_app;/,
    );
  });
});
