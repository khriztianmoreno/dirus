import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * data-model spec, "drizzle-kit reports no drift": the committed migration
 * files and the Drizzle schema must never diverge. `drizzle-kit check`
 * compares `migrations/meta/*_snapshot.json` (produced by `generate`)
 * against the current schema; the 3 hand-written migrations (0001-0003)
 * were created with `generate --custom`, which appends to
 * `meta/_journal.json` without touching the snapshot, so they never appear
 * as drift (design.md D-G).
 */
const packageDir = fileURLToPath(new URL("../..", import.meta.url));

describe("drizzle-kit check", () => {
  it("reports zero drift between the schema and the committed migrations", () => {
    const output = execFileSync("pnpm", ["exec", "drizzle-kit", "check"], {
      cwd: packageDir,
      encoding: "utf8",
      // drizzle-kit check only diffs the schema against migrations/meta —
      // it never opens a connection — but drizzle.config.ts reads
      // DATABASE_URL_UNPOOLED to build dbCredentials.url, so this must be
      // set to *something* syntactically URL-shaped even though it's never
      // dialed.
      env: {
        ...process.env,
        DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED ?? "postgres://placeholder/placeholder",
      },
    });
    expect(output).toMatch(/Everything's fine/);
  });
});
