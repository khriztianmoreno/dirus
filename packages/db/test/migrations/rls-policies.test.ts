import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * data-model spec, "Row Level Security Enforced and Forced" + design.md D-D
 * (spec gap, surfaced not patched): every table carrying `broker_id` MUST
 * have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, with a
 * policy that governs BOTH visible rows (`USING`) and written rows
 * (`WITH CHECK`). `brokers` itself is keyed on `id`, not `broker_id`.
 *
 * A `USING`-only policy still lets broker A INSERT a row carrying
 * `broker_id = B` — that's exactly the cross-tenant write D-D calls out as
 * the missing scenario in the base spec. This test asserts the migration's
 * SQL text contains a `WITH CHECK` clause per table, not just `USING`,
 * because that's the one guarantee no live-database test alone would catch
 * if the policy were quietly regenerated as `USING`-only (a live test would
 * still pass for reads; only an explicit cross-tenant INSERT attempt would
 * catch it, and that's a Phase 6 concern this static check catches earlier).
 *
 * Judgment Day round 1: `BROKER_ID_TABLES` used to be a hand-maintained
 * array, a second source of truth alongside `0000_init.sql`'s own `CREATE
 * TABLE` statements that could silently drift from them. It is now derived
 * from `0000_init.sql` itself — the table shapes this migration sequence
 * actually creates — instead of being retyped here. The live,
 * catalog-derived guard in `test/migrations/rls-catalog-guard.test.ts`
 * covers the case this static, source-derived list still cannot: a table
 * that exists in a live database but was never declared in `0000_init.sql`
 * at all (e.g. created out-of-band, or by a future migration file this test
 * doesn't read).
 */
const migrationPath = fileURLToPath(new URL("../../migrations/0002_rls_policies.sql", import.meta.url));
const sql = readFileSync(migrationPath, "utf8");

const BROKER_ID_TABLES = discoverBrokerIdTables();

const PREDICATE = "nullif(current_setting('app.broker_id', true), '')::uuid";

describe("0002_rls_policies.sql", () => {
  it("enables and forces RLS on brokers, keyed on id", () => {
    expect(sql).toMatch(/ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/ALTER TABLE brokers FORCE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(
      new RegExp(
        `CREATE POLICY tenant_isolation ON brokers FOR ALL\\s+USING\\s*\\(id = ${escape(PREDICATE)}\\)\\s+WITH CHECK\\s*\\(id = ${escape(PREDICATE)}\\);`,
      ),
    );
  });

  it.each(BROKER_ID_TABLES)("enables, forces, and WITH CHECKs RLS on %s, keyed on broker_id", (table) => {
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
    expect(sql).toMatch(
      new RegExp(
        `CREATE POLICY tenant_isolation ON ${table} FOR ALL\\s+USING\\s*\\(broker_id = ${escape(PREDICATE)}\\)\\s+WITH CHECK\\s*\\(broker_id = ${escape(PREDICATE)}\\);`,
      ),
    );
  });

  it("never declares a USING-only policy (every CREATE POLICY has a WITH CHECK)", () => {
    // Count of CREATE POLICY statements must equal count of WITH CHECK
    // clauses — a policy with USING but no WITH CHECK would under-count here.
    const policyCount = (sql.match(/CREATE POLICY tenant_isolation/g) ?? []).length;
    // Anchored to line-start (only real clauses, not the header comment's
    // prose mentioning "WITH CHECK").
    const withCheckCount = (sql.match(/^\s*WITH CHECK/gm) ?? []).length;
    expect(policyCount).toBe(9);
    expect(withCheckCount).toBe(9);
  });

  it("uses the 2-argument current_setting + nullif form everywhere (fails closed)", () => {
    // design.md D-E: the 1-arg form raises undefined_object when unset,
    // which errors instead of returning zero rows.
    expect(sql).not.toMatch(/current_setting\('app\.broker_id'\)/);
  });
});

function escape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses `0000_init.sql`'s `CREATE TABLE "name" (...);` blocks and returns
 * every table (other than `brokers`, which is keyed on `id` and asserted
 * separately) whose column list declares `broker_id`. Source-derived, not
 * hand-maintained: adding or removing a `broker_id` column in `0000_init.sql`
 * changes this list without anyone having to remember to also edit this file.
 */
function discoverBrokerIdTables(): string[] {
  const initPath = fileURLToPath(new URL("../../migrations/0000_init.sql", import.meta.url));
  const initSql = readFileSync(initPath, "utf8");
  const tableBlockPattern = /CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g;

  const tables: string[] = [];
  for (const match of initSql.matchAll(tableBlockPattern)) {
    const [, tableName, columns] = match;
    if (tableName !== "brokers" && /^\s*"broker_id"\s/m.test(columns)) {
      tables.push(tableName);
    }
  }
  return tables.sort();
}
