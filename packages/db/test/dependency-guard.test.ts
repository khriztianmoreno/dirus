import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// design.md D-A: `@neondatabase/serverless` has no transactions (each query is
// its own implicit transaction), so `withBrokerContext`'s `set_config(...,
// true)` would silently isolate nothing. It must never be a dependency.
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

describe("driver enforcement (design.md D-A: node-postgres, never the Neon HTTP driver)", () => {
  it("never declares @neondatabase/serverless as a dependency", () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    expect(Object.keys(allDeps)).not.toContain("@neondatabase/serverless");
  });

  it("declares pg as the runtime driver", () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies).toHaveProperty("pg");
  });
});
