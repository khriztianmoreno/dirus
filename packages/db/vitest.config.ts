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
      // C1 phase 1: `live-tenant-resolution.test.ts`, `migrate-runner-live
      // .test.ts`, `tenant-resolver-migration.test.ts`, and (new)
      // `live-broker-auth.test.ts` each `CREATE ROLE`/`DROP ROLE` a role
      // literally named `dirus_app` — deliberately, so the migrations'
      // `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dirus_app')`
      // guards get exercised against the real production role name, the
      // same reasoning `migrate-runner-live.test.ts` established. Roles are
      // cluster-global in Postgres, never per-database, so each file's own
      // dedicated database does NOT isolate this — two of these files
      // running as concurrent Vitest workers race on the same role, and one
      // file's `DROP ROLE`/`CREATE ROLE` can interleave with another's,
      // producing "role does not exist" or "role already exists" (CI run
      // 34041996248, first CI run of live-broker-auth.test.ts).
      //
      // This is the same class of failure `throwaway-schema.ts`'s docstring
      // records as "Judgment Day round 6": Vitest's default file
      // parallelism against shared, cluster-global Postgres state. Round 6's
      // resolution there was to eliminate the race (remove the sweep)
      // rather than add coordination machinery (a lock) to survive it. The
      // equivalent move here is removing the gratuitous parallelism these
      // tests were never designed to tolerate — not adding a lock around
      // five separate files' role-management code.
      fileParallelism: false,
    },
  }),
);
