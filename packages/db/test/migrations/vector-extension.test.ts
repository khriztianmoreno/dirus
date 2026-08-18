import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * data-model spec, "pgvector Extension Enabled": `CREATE EXTENSION IF NOT
 * EXISTS vector` MUST run as part of the migration set, and no table in the
 * schema may declare a `vector(...)` column (D4: the `doc_chunks` table
 * itself is deferred to a later phase).
 */
const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
const vectorMigrationPath = fileURLToPath(
  new URL("../../migrations/0001_vector_extension.sql", import.meta.url),
);
const vectorMigrationSql = readFileSync(vectorMigrationPath, "utf8");

describe("0001_vector_extension.sql", () => {
  it("creates the vector extension if it does not already exist", () => {
    expect(vectorMigrationSql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector;/);
  });

  it("declares no vector(...) column in any committed migration", () => {
    const sqlFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
    expect(sqlFiles.length).toBeGreaterThan(0);

    for (const file of sqlFiles) {
      const contents = readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
      // A real column declaration looks like `vector(1536)` — require a
      // numeric dimension so this doesn't false-positive on prose mentioning
      // "vector(...)" in a migration's own comments.
      expect(contents, `${file} must not declare a vector(N) column`).not.toMatch(/\bvector\s*\(\s*\d+\s*\)/i);
    }
  });
});
