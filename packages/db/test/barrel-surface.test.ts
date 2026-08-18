import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// design.md D-C: structural non-bypassability. The raw pooled `db` (and the
// admin client) must never be reachable outside `withBrokerContext()`.
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

describe("packages/db public surface (design.md D-C: non-bypassable barrel)", () => {
  it("package.json#exports publishes only '.' and './schema'", () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      exports?: Record<string, string>;
    };

    expect(manifest.exports).toBeDefined();
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([".", "./schema"]);
  });

  it("the barrel (src/index.ts) exports withBrokerContext, TenantDb, and schema but never a raw db", async () => {
    const barrel = (await import("../src/index.js")) as Record<string, unknown>;

    expect(barrel.withBrokerContext).toBeTypeOf("function");
    expect(barrel).not.toHaveProperty("db");
    expect(barrel).not.toHaveProperty("pool");
    expect(barrel).not.toHaveProperty("unsafeAdminDb");
  });

  it("the barrel source text never re-exports ./internal/client or ./internal/admin", async () => {
    const barrelPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const source = readFileSync(barrelPath, "utf-8");

    expect(source).not.toMatch(/from\s+["']\.\/internal\/client/);
    expect(source).not.toMatch(/from\s+["']\.\/internal\/admin/);
  });
});
