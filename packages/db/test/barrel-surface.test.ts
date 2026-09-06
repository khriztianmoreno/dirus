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

  it("the barrel (src/index.ts) exports exactly withBrokerContext, assertUuid, resolveBrokerIdByWaPhoneNumberId, brokerExists, and schema — never a raw db", async () => {
    const barrel = (await import("../src/index.js")) as Record<string, unknown>;

    // Exhaustive allowlist, not a denylist: `TenantDb` is type-only and is
    // erased at runtime, so it does not appear here. Any new runtime export
    // (e.g. an accidental `pool as rawClient`) must fail this assertion.
    //
    // design.md D-7: `resolveBrokerIdByWaPhoneNumberId` is deliberately added
    // here rather than left implicit — the allowlist is exhaustive precisely
    // so that adding a new runtime export is a reviewed decision, not a
    // silent test edit.
    //
    // `brokerExists` (`policy-bulk-import` task 6.4) added the same way —
    // reviewed here, not silently. It is NOT a D-7-style narrow-access
    // exception: it reads through `withBrokerContext`/`TenantDb` like any
    // other table read (see `src/broker-existence.ts`'s docstring).
    expect(Object.keys(barrel).sort()).toEqual([
      "assertUuid",
      "brokerExists",
      "resolveBrokerIdByWaPhoneNumberId",
      "schema",
      "withBrokerContext",
    ]);
    expect(barrel.withBrokerContext).toBeTypeOf("function");
    expect(barrel.resolveBrokerIdByWaPhoneNumberId).toBeTypeOf("function");
    expect(barrel.brokerExists).toBeTypeOf("function");
  });

  it("the barrel source text never re-exports ./internal/client or ./internal/admin", async () => {
    const barrelPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const source = readFileSync(barrelPath, "utf-8");

    expect(source).not.toMatch(/from\s+["']\.\/internal\/client/);
    expect(source).not.toMatch(/from\s+["']\.\/internal\/admin/);
  });
});
