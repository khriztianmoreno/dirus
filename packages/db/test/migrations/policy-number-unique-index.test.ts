import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * data-model delta spec (`policy-bulk-import`, "Partial Unique Index on
 * Numbered Policies"), scenario "The committed migration SQL encodes a
 * partial index, not a plain or NULLS-NOT-DISTINCT one": a static-SQL check
 * against the *committed* migration file, mirroring
 * `partial-indexes.test.ts`'s convention of asserting on migration text
 * rather than a live database.
 *
 * Proposal P5 is explicit that a plain `UNIQUE (broker_id, policy_number)`
 * would *appear* correct in every test that always supplies a
 * `policy_number` (Postgres already treats NULLs as distinct in a plain
 * unique index too), and that `NULLS NOT DISTINCT` (PG15+) is actively
 * destructive — it would collapse every unnumbered policy for a broker into
 * one row. This test guards the migration's own SQL text against both wrong
 * shapes, not just for the presence of the right one.
 */
const migrationPath = fileURLToPath(
  new URL("../../migrations/0005_policy_number_unique_index.sql", import.meta.url),
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("0005_policy_number_unique_index.sql", () => {
  it("declares a unique index on policies (broker_id, policy_number)", () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX .*ON "policies" USING btree \("broker_id","policy_number"\)/,
    );
  });

  it("scopes the index with a WHERE policy_number IS NOT NULL clause, verbatim", () => {
    expect(migrationSql).toMatch(/WHERE "policies"\."policy_number" IS NOT NULL/);
  });

  it("does not use NULLS NOT DISTINCT, which would collapse distinct unnumbered policies", () => {
    expect(migrationSql).not.toMatch(/NULLS NOT DISTINCT/i);
  });
});
