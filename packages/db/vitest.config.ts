import { mergeConfig, defineConfig } from "vitest/config";
import base from "@dirus/config/vitest.config.ts";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // A default pooled DATABASE_URL so importing `./tenant.js` (which
      // transitively imports `./internal/client.js`) doesn't require every
      // unrelated test file to set env vars. Tests that specifically
      // exercise the env guards (client-env-guards.test.ts) delete/override
      // these per test.
      setupFiles: ["./test/setup.ts"],
    },
  }),
);
