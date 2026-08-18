import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * data-model spec, "Partial indexes exist and are partial": the committed
 * migration SQL for `policies` and `extractions` must include their `WHERE`
 * clause verbatim (not a full-table index).
 *
 * This is a static-SQL check against the *committed* migration file, not the
 * Drizzle schema — a regression here (e.g. drizzle-kit silently dropping
 * the WHERE clause, or someone hand-editing the migration) would otherwise
 * only surface once a live database is queried.
 *
 * `eq(table.status, "active")`/`eq(table.needsReview, true)` render as a
 * bound `$1` placeholder in generated migration SQL, which is invalid
 * inside a partial index's WHERE clause (there is no query parameter in a
 * raw DDL statement). The schema files use the `sql` tag instead
 * (`packages/db/src/schema/{policies,extractions}.ts`) specifically to
 * avoid that.
 */
const migrationPath = fileURLToPath(new URL("../../migrations/0000_init.sql", import.meta.url));
const migrationSql = readFileSync(migrationPath, "utf8");

describe("0000_init.sql partial indexes", () => {
  it("keeps the policies partial index WHERE clause verbatim", () => {
    expect(migrationSql).toMatch(
      /CREATE INDEX "policies_broker_id_end_date_index" ON "policies" USING btree \("broker_id","end_date"\) WHERE "policies"\."status" = 'active';/,
    );
  });

  it("keeps the extractions partial index WHERE clause verbatim", () => {
    expect(migrationSql).toMatch(
      /CREATE INDEX "extractions_broker_id_needs_review_index" ON "extractions" USING btree \("broker_id","needs_review"\) WHERE "extractions"\."needs_review" = true;/,
    );
  });

  it("never emits an unbound query placeholder ($N) inside the migration", () => {
    // A regression to the eq()-based partial-index builder renders WHERE
    // clauses as `WHERE "col" = $1` — invalid in a raw DDL statement (no
    // parameter binding exists at migration-apply time). This guards
    // against that regression class as a whole, not just the two known
    // partial indexes above.
    expect(migrationSql).not.toMatch(/\$\d+/);
  });
});
