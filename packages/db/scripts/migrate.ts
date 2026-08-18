import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { parseHost } from "../src/internal/parse-host.js";

/**
 * `pnpm db:migrate` (design.md D-G). Runs, strictly in order:
 *
 *   1. `assertUnpooledUrlConfigured` — `DATABASE_URL_UNPOOLED` must be set.
 *   2. `assertNotPooledHost` — its host must not be a pooled Neon endpoint.
 *      DDL (this script's entire purpose) must never cross a transaction
 *      pooler.
 *   3. `smokeTestConnection` — a bounded (default 5s) `SELECT 1` proves the
 *      connection is actually reachable before any DDL is attempted.
 *   4. Only then: the Drizzle migrator, via `unsafeAdminDb`
 *      (`../src/internal/admin.ts`) — the sole intended caller of that
 *      module outside its own tests.
 *
 * Each guard is a small, pure(ish) function on purpose: a bad or
 * unreachable URL must fail before touching the migrator, never mid-way
 * through applying a migration file.
 */

const DEFAULT_SMOKE_TEST_TIMEOUT_MS = 5000;

export function assertUnpooledUrlConfigured(): string {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    throw new Error(
      "DATABASE_URL_UNPOOLED is required to run migrations (direct Neon connection, see " +
        ".env.example). Refusing to run migrations without it — DDL must never be attempted " +
        "against an unconfigured connection.",
    );
  }
  return url;
}

export function assertNotPooledHost(url: string): void {
  const host = parseHost("DATABASE_URL_UNPOOLED", url);
  if (host.includes("-pooler")) {
    throw new Error(
      `DATABASE_URL_UNPOOLED host "${host}" looks like a pooled Neon endpoint. Migrations ` +
        "run DDL, which must never cross a transaction pooler — point this variable at the " +
        "direct (unpooled) Neon connection.",
    );
  }
}

/**
 * Bounded connectivity smoke test. Deliberately uses its own short-lived
 * `pg.Client` (not `unsafeAdminDb`/`adminPool`) so a failed smoke test never
 * leaves a pool half-initialized, and races the connect+query against an
 * explicit timer so an unreachable host that merely hangs (rather than
 * refusing the connection outright) cannot stall the migration run forever.
 *
 * The thrown message only ever includes `host` — derived from a
 * successfully parsed URL (`parseHost`'s contract) — never any other part
 * of the raw connection string, which would contain credentials.
 */
export async function smokeTestConnection(
  url: string,
  timeoutMs: number = DEFAULT_SMOKE_TEST_TIMEOUT_MS,
): Promise<void> {
  const host = parseHost("DATABASE_URL_UNPOOLED", url);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: timeoutMs });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("smoke test timed out")), timeoutMs);
  });

  try {
    await Promise.race([client.connect().then(() => client.query("SELECT 1")), timeout]);
  } catch {
    throw new Error(`cannot connect to Neon: ${host}`);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    await client.end().catch(() => {
      // Best-effort cleanup — the client may never have finished
      // connecting; nothing further to do if `end()` itself fails.
    });
  }
}

export async function runMigrations(): Promise<void> {
  const url = assertUnpooledUrlConfigured();
  assertNotPooledHost(url);
  await smokeTestConnection(url);

  const { unsafeAdminDb, adminPool } = await import("../src/internal/admin.js");
  const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

  try {
    await migrate(unsafeAdminDb, { migrationsFolder });
  } finally {
    await adminPool.end();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied successfully.");
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
