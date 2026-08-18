import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema/index.js";

/**
 * Runtime client (design.md D-A/D-B). This module — and `./admin.ts` — are
 * NOT published from the package root: `package.json#exports` only exposes
 * `.` and `./schema`, so callers can never obtain the raw pooled `db`
 * outside `withBrokerContext()` (design.md D-C, structural non-bypassability
 * point 1).
 *
 * Both guards below run at import time, not lazily: a missing or
 * misconfigured `DATABASE_URL` must fail loudly before any query is issued,
 * never silently degrade to an unpooled connection where `SET LOCAL` /
 * `set_config(..., true)` would still work but PgBouncer transaction pooling
 * assumptions would not hold.
 */

function readDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required (pooled Neon connection string, see .env.example). " +
        "Refusing to start without it — the app runtime must never fall back to an unpooled connection.",
    );
  }
  return url;
}

function parseHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(
      `DATABASE_URL is not a well-formed connection URL (received a value shaped like ` +
        `${JSON.stringify(url.slice(0, 20))}...). Expected a postgres:// URL, e.g. ` +
        "postgres://user:pass@host/db — a libpq keyword/value string " +
        '("host=... dbname=...") is not accepted here.',
    );
  }
}

function assertPooledHost(url: string): void {
  const host = parseHost(url);
  const isPooled = host.includes("-pooler");
  const allowUnpooledRuntime = process.env.ALLOW_UNPOOLED_RUNTIME === "1";

  if (!isPooled && !allowUnpooledRuntime) {
    throw new Error(
      `DATABASE_URL host "${host}" does not look like a pooled Neon endpoint ` +
        '(expected "-pooler" in the hostname). The app runtime must use the pooled ' +
        "connection. Set ALLOW_UNPOOLED_RUNTIME=1 to override (documented interim only).",
    );
  }
}

const databaseUrl = readDatabaseUrl();
assertPooledHost(databaseUrl);

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });
