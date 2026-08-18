import { defineConfig } from "vitest/config";

/**
 * Shared base Vitest config. Packages import and extend this via:
 *
 *   import { mergeConfig } from "vitest/config";
 *   import base from "@dirus/config/vitest.config.ts";
 *   export default mergeConfig(base, defineConfig({ ... }));
 */
export const base = defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});

export default base;
