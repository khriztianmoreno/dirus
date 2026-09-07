import { mergeConfig, defineConfig } from "vitest/config";
import base from "@dirus/config/vitest.config.ts";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // `test/live/webhook-ingress.live.test.ts` (F2), `magic-link-consumption
      // .live.test.ts`, and `session-lifecycle.live.test.ts` (C1) each
      // `CREATE ROLE`/`DROP ROLE` a role literally named `dirus_app` against
      // their own dedicated database — deliberately, mirroring the real
      // production role name (same reasoning as `packages/db/vitest.config
      // .ts`). Roles are cluster-global in Postgres, never per-database, so
      // each file's own dedicated database does NOT isolate this: with
      // Vitest's default file parallelism, one file's `DROP ROLE` can run
      // while another file still owns objects under that same role name,
      // failing with "role dirus_app cannot be dropped because some objects
      // depend on it" (CI run 34134305357, session-lifecycle's cleanup
      // tripped by webhook-ingress's still-live objects).
      //
      // Same "Judgment Day round 6" class of failure `throwaway-schema.ts`'s
      // docstring records, and the same fix `packages/db/vitest.config.ts`
      // already applies: eliminate the race by removing the gratuitous
      // parallelism these files were never designed to tolerate, rather than
      // adding coordination machinery around three separate files' shared
      // role name.
      fileParallelism: false,
    },
  }),
);
