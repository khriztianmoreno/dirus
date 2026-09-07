import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `admin-dashboard` (C1) tasks 3.16-3.17, design.md D-A's callback
 * data-flow, broker-auth spec "Token Consumption Is Single-Use", "Token
 * Expiry Is Enforced Server-Side". Exercises the REAL `consumeMagicLinkToken`
 * (`services/auth/consume-magic-link.ts`) against a real transaction — the
 * boundary where a fake can no longer stand in for atomicity, per F2's
 * precedent for testing a real transaction's behavior directly rather than
 * only through fakes.
 *
 * **Convention mix, deliberately** (mirrors `policies-import.live.test.ts`'s
 * own "convention mix" note): this suite needs `withBrokerContext`'s real
 * login role (`dirus_app`) for the write path, combined with
 * `policies-import.live.test.ts`'s throwaway-schema convention (never
 * `public` — this suite has no dependency on `0006_broker_auth.sql`'s
 * `SECURITY DEFINER` functions or its `dirus_tenant_resolver`-scoped
 * grants/policies, which are the ONLY reason `live-broker-auth.test.ts`
 * needs its own dedicated database targeting the real `public` schema).
 *
 * Only a narrow SLICE of `0006_broker_auth.sql` is applied here —
 * `applyBrokerAuthTablesAndRls` below applies just the `magic_link_tokens`/
 * `sessions` `CREATE TABLE`s, their FK constraints (schema-qualification
 * rewritten, like `0000`/`0002`), and their `tenant_isolation` RLS
 * policies. The `broker_users.email` unique index, the
 * `dirus_tenant_resolver`-scoped grants/policies, and the three
 * `SECURITY DEFINER` functions are deliberately EXCLUDED — applying them
 * unmodified into a throwaway schema would create real objects in this
 * database's ACTUAL `public` schema (their bodies hardcode `public.*`,
 * unlike the FK constraints' quoted `"public".` form that `drizzle-kit`
 * generates and which `rewriteSchemaQualification` safely rewrites). This
 * suite does not need them: `resolveBrokerIdByMagicLinkTokenHash` is
 * injected as a fake in every `it()` below (it is exercised for real by
 * `live-broker-auth.test.ts`'s own Phase 2 block), so only the atomic
 * UPDATE inside `withBrokerContext` — which needs no resolver function at
 * all — is under test here.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable
 * (verified directly: `docker info` reports no daemon, no `podman`/`psql`
 * binary, `nc -z localhost 5432` closed). `LIVE_TEST_DATABASE_URL` is
 * unset here, so this entire suite reports SKIPPED, not run. It must
 * execute in CI.
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../packages/db/migrations/${file}`, import.meta.url)),
    "utf8",
  );
}

/** Same rewrite `packages/db/test/migrations/throwaway-schema.ts` performs, duplicated locally — this file lives in `apps/api`, across the package boundary from that helper (mirrors `policies-import.live.test.ts`'s identical note). */
function rewriteSchemaQualification(sqlText: string, schema: string): string {
  return sqlText.replaceAll('"public".', `"${schema}".`);
}

function rewriteUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

function randomThrowawaySchemaName(): string {
  return `magic_link_live_${randomBytes(6).toString("hex")}`;
}

async function assertThrowawayDatabase(client: Client): Promise<void> {
  if (process.env.ALLOW_DESTRUCTIVE_LIVE_TESTS === "1") return;
  const result = await client.query<{ current_database: string }>("SELECT current_database()");
  const dbName = result.rows[0]?.current_database ?? "";
  if (!/(_test|_ci)$/i.test(dbName)) {
    throw new Error(
      `refusing to run destructive live tests against database "${dbName}": its name does ` +
        `not end in "_test" or "_ci". Set ALLOW_DESTRUCTIVE_LIVE_TESTS=1 to override.`,
    );
  }
}

/**
 * Applies ONLY the `magic_link_tokens`/`sessions` table DDL, their FK
 * constraints, and their `tenant_isolation` RLS policies from
 * `0006_broker_auth.sql` — see the file header's "Convention mix" note for
 * why the rest of that migration is deliberately excluded. Blocks are
 * split on `drizzle-kit`'s own `--> statement-breakpoint` marker (the same
 * marker `0006`'s own structural test, `broker-auth-migration.test.ts`,
 * reasons about), rewritten for the throwaway schema, then filtered:
 * ANY block that still contains the literal substring `"public."` after
 * rewriting is skipped outright — this is what excludes the email index,
 * every `dirus_tenant_resolver`-scoped GRANT/POLICY, and all three
 * `SECURITY DEFINER` functions (whose bodies hardcode `public.*` and are
 * never rewritten, by design — see `0006`'s own file header on why that
 * qualification exists).
 */
async function applyBrokerAuthTablesAndRls(client: Client, schema: string): Promise<void> {
  const rewritten = rewriteSchemaQualification(readMigration("0006_broker_auth.sql"), schema);
  const blocks = rewritten.split("--> statement-breakpoint");

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.includes("public.")) continue;
    await client.query(trimmed);
  }
}

const OWNER_ROLE = "magic_link_live_owner";
const OWNER_PASSWORD = "magic-link-live-owner-pass";
const APP_ROLE = "magic_link_live_app";
const APP_PASSWORD = "magic-link-live-app-pass";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * `@dirus/db`'s internal client reads `DATABASE_URL` at IMPORT time
 * (design.md D-B), so each caller resets modules and re-imports fresh,
 * authenticated as `APP_ROLE` against this file's own throwaway schema —
 * mirrors `policies-import.live.test.ts`'s and `webhook-ingress.live.test.ts`'s
 * identical convention. Neither of those two files closes the internal
 * pool either (`@dirus/db`'s public barrel does not export it, per
 * design.md D-C's stance on what this package exposes) — the pool is left
 * open until the `vitest run` process exits, matching this repo's own
 * apps/api live-test convention exactly.
 */
async function importRealServices() {
  vi.resetModules();
  process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
  process.env.ALLOW_UNPOOLED_RUNTIME = "1";

  const { consumeMagicLinkToken } = await import("../../src/services/auth/consume-magic-link.js");
  return { consumeMagicLinkToken };
}

describe.skipIf(!liveUrl)("consumeMagicLinkToken — live, real transaction (tasks 3.16-3.17)", () => {
  let admin: Client;
  let schema: string;
  let brokerId: string;
  let brokerUserId: string;
  let safeToMutate = false;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    await assertThrowawayDatabase(admin);

    await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);

    schema = randomThrowawaySchemaName();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    safeToMutate = true;

    await admin.query(`CREATE ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CREATE, USAGE ON SCHEMA "${schema}" TO ${OWNER_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${APP_ROLE}`);
    await admin.query(`ALTER ROLE ${OWNER_ROLE} SET search_path TO "${schema}"`);
    await admin.query(`ALTER ROLE ${APP_ROLE} SET search_path TO "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);

    const owner = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, OWNER_PASSWORD) });
    await owner.connect();
    try {
      // 0000 (brokers, broker_users, ...) and 0002 (RLS) applied AS the
      // owning role, so FORCE ROW LEVEL SECURITY binds a role distinct
      // from `admin` and `APP_ROLE` — the same reasoning
      // `policies-import.live.test.ts` documents.
      await owner.query(rewriteSchemaQualification(readMigration("0000_init.sql"), schema));
      await owner.query(rewriteSchemaQualification(readMigration("0002_rls_policies.sql"), schema));
      // Only the magic_link_tokens/sessions table+FK+RLS slice — see this
      // file's header and `applyBrokerAuthTablesAndRls`'s own docstring.
      await applyBrokerAuthTablesAndRls(owner, schema);
    } finally {
      await owner.end();
    }

    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}`);

    const brokerResult = await admin.query<{ id: string }>(
      `SET search_path TO "${schema}"; INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ('Broker ML', 'ml-phone', 'ml-waba') RETURNING id`,
    );
    brokerId = brokerResult.rows[brokerResult.rows.length - 1].id;
    const userResult = await admin.query<{ id: string }>(
      `SET search_path TO "${schema}"; INSERT INTO broker_users (broker_id, name, phone) VALUES ($1, 'ML User', 'ml-user-phone') RETURNING id`,
      [brokerId],
    );
    brokerUserId = userResult.rows[userResult.rows.length - 1].id;
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      if (safeToMutate) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
        await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
      }
    } finally {
      await admin.end();
    }
  });

  async function insertToken(expiresAtSql: string): Promise<{ rawToken: string; tokenHash: string }> {
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(rawToken);
    await admin.query(
      `SET search_path TO "${schema}"; INSERT INTO magic_link_tokens (broker_id, broker_user_id, token_hash, expires_at) VALUES ($1, $2, $3, ${expiresAtSql})`,
      [brokerId, brokerUserId, tokenHash],
    );
    return { rawToken, tokenHash };
  }

  it("task 3.16: a fresh token is consumed successfully (used_at becomes non-null); the same raw token consumed again is rejected, used_at unchanged from the first consumption", async () => {
    const { tokenHash } = await insertToken("now() + interval '15 minutes'");
    const { consumeMagicLinkToken } = await importRealServices();

    const first = await consumeMagicLinkToken({ brokerId, tokenHash });
    expect(first).toEqual({ ok: true, brokerUserId });

    const afterFirst = await admin.query<{ used_at: string }>(
      `SET search_path TO "${schema}"; SELECT used_at FROM magic_link_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const usedAtAfterFirst = afterFirst.rows[afterFirst.rows.length - 1].used_at;
    expect(usedAtAfterFirst).not.toBeNull();

    const second = await consumeMagicLinkToken({ brokerId, tokenHash });
    expect(second).toEqual({ ok: false });

    const afterSecond = await admin.query<{ used_at: string }>(
      `SET search_path TO "${schema}"; SELECT used_at FROM magic_link_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const usedAtAfterSecond = afterSecond.rows[afterSecond.rows.length - 1].used_at;
    expect(usedAtAfterSecond).toBe(usedAtAfterFirst);
  });

  it("task 3.17: a token expiring exactly 15 minutes after issuance succeeds just before expiry; a token whose expires_at is already in the past is rejected", async () => {
    const { tokenHash: validHash } = await insertToken("now() + interval '15 minutes'");
    const { tokenHash: expiredHash } = await insertToken("now() - interval '1 second'");
    const { consumeMagicLinkToken } = await importRealServices();

    const validResult = await consumeMagicLinkToken({ brokerId, tokenHash: validHash });
    expect(validResult).toEqual({ ok: true, brokerUserId });

    const expiredResult = await consumeMagicLinkToken({ brokerId, tokenHash: expiredHash });
    expect(expiredResult).toEqual({ ok: false });

    const expiredRow = await admin.query<{ used_at: string | null }>(
      `SET search_path TO "${schema}"; SELECT used_at FROM magic_link_tokens WHERE token_hash = $1`,
      [expiredHash],
    );
    expect(expiredRow.rows[expiredRow.rows.length - 1].used_at).toBeNull();
  });
});
