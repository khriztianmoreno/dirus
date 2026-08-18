import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema/index.js";

/**
 * Admin client for migrations/DDL only (design.md D-B/D-G). Uses
 * `DATABASE_URL_UNPOOLED` — a direct (non-PgBouncer) connection, required
 * because DDL such as `CREATE EXTENSION`, `CREATE ROLE`, and
 * `ALTER TABLE ... FORCE ROW LEVEL SECURITY` must not cross a transaction
 * pooler.
 *
 * `unsafeAdminDb` is deliberately named and deliberately NOT re-exported
 * from `src/index.ts` (design.md D-C, structural non-bypassability point 3)
 * — only `packages/db/scripts/migrate.ts` (Phase 5) imports it directly via
 * a relative path, which `package.json#exports` still blocks for external
 * consumers.
 */

function readUnpooledUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    throw new Error(
      "DATABASE_URL_UNPOOLED is required for migrations/DDL (direct Neon connection, " +
        "see .env.example). Refusing to start without it.",
    );
  }
  return url;
}

function parseHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(
      `DATABASE_URL_UNPOOLED is not a well-formed connection URL (received a value shaped ` +
        `like ${JSON.stringify(url.slice(0, 20))}...). Expected a postgres:// URL, e.g. ` +
        "postgres://user:pass@host/db — a libpq keyword/value string " +
        '("host=... dbname=...") is not accepted here.',
    );
  }
}

function assertUnpooledHost(url: string): void {
  const host = parseHost(url);
  if (host.includes("-pooler")) {
    throw new Error(
      `DATABASE_URL_UNPOOLED host "${host}" looks like a pooled endpoint. DDL must not ` +
        "cross a transaction pooler — point this variable at the direct Neon connection.",
    );
  }
}

const unpooledUrl = readUnpooledUrl();
assertUnpooledHost(unpooledUrl);

const adminPool = new Pool({ connectionString: unpooledUrl });
export const unsafeAdminDb = drizzle(adminPool, { schema });
