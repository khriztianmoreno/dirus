import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionAuthMiddleware } from "../../src/middleware/session-auth.js";

/**
 * `admin-dashboard` (C1) tasks 4.9, 4.10, 4.13 — the three live-only Phase 4
 * proofs. Combined in ONE file (unlike Phase 3's single-purpose live test)
 * because all three need the SAME fixture: a real broker/broker_user, the
 * real `dirus_resolve_broker_id_by_session` `SECURITY DEFINER` function, and
 * a real `sessions` row — the exact shape `live-broker-auth.test.ts`'s own
 * fixture already proves live for `packages/db`.
 *
 * **Own dedicated database** (`SESSION_LIFECYCLE_TEST_DATABASE_URL`), not
 * the shared `LIVE_TEST_DATABASE_URL` throwaway-schema convention —
 * identical reasoning to `live-broker-auth.test.ts`'s file header:
 * `0006_broker_auth.sql`'s three `SECURITY DEFINER` function bodies
 * hardcode `public.*` (the search_path-hijack defense itself), so they
 * cannot run against a randomly-named throwaway schema. Migrations
 * 0000/0002/0004/0006 are applied to this database's own real `public`
 * schema, full teardown in `afterAll` — mirrors `live-broker-auth.test.ts`'s
 * `beforeAll`/`afterAll` shape exactly.
 *
 * **Why a local "probe" Hono app, not a route mounted in `app.ts`**: tasks
 * 4.9/4.10 need a session-protected GET endpoint to observe the sliding-
 * window touch and its concurrency behavior. Phase 4 deliberately mounts
 * `session-auth.ts`/`csrf-guard.ts` on `/auth/logout` ONLY — no dashboard
 * data route exists yet (task 4.15, Phases 5-6 add those). Rather than
 * mounting a throwaway GET route in the real `app.ts` just to satisfy this
 * test, `buildProbeApp` below wires `createSessionAuthMiddleware` directly
 * against the REAL `resolveSession` (`services/auth/resolve-session.ts`)
 * on a private, test-local `Hono` instance — this exercises the real
 * resolver/touch-session code path without adding scope to `app.ts` that
 * belongs to a later phase.
 *
 * **Dispatch pattern for 4.10 is load-bearing**, mirroring
 * `webhook-ingress.live.test.ts`'s (F2 Phase 6) convention exactly:
 * `Promise.all([...])` — every concurrent request dispatched before any is
 * awaited — never a sequential `await` loop, which would prove nothing
 * about a race.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable (no
 * Docker/Podman, `nc -z localhost 5432` closed). `SESSION_LIFECYCLE_TEST_DATABASE_URL`
 * is unset here, so this entire suite reports SKIPPED, not run. It must
 * execute in CI. Task 4.10's actual concurrency outcome (deadlock-safe or
 * not) is therefore UNCONFIRMED in this environment — recorded as such in
 * apply-progress.md, not assumed passing.
 */
const liveUrl = process.env.SESSION_LIFECYCLE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../packages/db/migrations/${file}`, import.meta.url)), "utf8");
}

function rewriteUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
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

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const OWNER_ROLE = "session_lifecycle_owner";
const OWNER_PASSWORD = "session-lifecycle-owner-pass";
const APP_ROLE = "dirus_app";
const APP_PASSWORD = "session-lifecycle-app-pass";
const WEBHOOK_TOKEN = "w".repeat(32);
const ADMIN_API_TOKEN = "a".repeat(32);

/**
 * `@dirus/db`'s internal client reads `DATABASE_URL` at import time —
 * mirrors `magic-link-consumption.live.test.ts`'s/`webhook-ingress.live.test.ts`'s
 * identical `vi.resetModules()` + fresh-import convention.
 */
async function importRealServices() {
  vi.resetModules();
  process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
  process.env.ALLOW_UNPOOLED_RUNTIME = "1";

  const { resolveSession } = await import("../../src/services/auth/resolve-session.js");
  const { revokeSession } = await import("../../src/services/auth/revoke-session.js");
  const {
    resolveBrokerIdByEmail,
    resolveBrokerIdByMagicLinkTokenHash,
  } = await import("@dirus/db");
  const { consumeMagicLinkToken } = await import("../../src/services/auth/consume-magic-link.js");
  const { createSession } = await import("../../src/services/auth/create-session.js");
  const { createApp } = await import("../../src/app.js");

  return {
    resolveSession,
    revokeSession,
    resolveBrokerIdByEmail,
    resolveBrokerIdByMagicLinkTokenHash,
    consumeMagicLinkToken,
    createSession,
    createApp,
  };
}

function buildProbeApp(resolveSession: Awaited<ReturnType<typeof importRealServices>>["resolveSession"]) {
  // `session-auth.ts` itself is `@dirus/db`-free (design.md D-D) — safe to
  // import statically at this file's top level even though the REST of
  // this suite only loads `@dirus/db`-touching modules dynamically, after
  // `DATABASE_URL` is set (see `importRealServices`).
  const app = new Hono<{ Variables: { brokerId: string; session: unknown } }>();
  app.get("/probe", createSessionAuthMiddleware(resolveSession), async (c) => c.body(null, 200));
  return app;
}

describe.skipIf(!liveUrl)("session lifecycle — live sliding window, concurrency, and end-to-end logout (tasks 4.9, 4.10, 4.13)", () => {
  let admin: Client;
  let brokerId: string;
  let brokerUserId: string;
  let safeToMutate = false;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    await assertThrowawayDatabase(admin);

    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
    await admin.query("DROP ROLE IF EXISTS dirus_tenant_resolver");

    safeToMutate = true;

    await admin.query(`CREATE ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER_ROLE}`);

    const owner = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, OWNER_PASSWORD) });
    await owner.connect();
    try {
      await owner.query(readMigration("0000_init.sql"));
      await owner.query(readMigration("0002_rls_policies.sql"));
    } finally {
      await owner.end();
    }

    // 0004 creates dirus_tenant_resolver (which 0006 extends); both applied
    // as admin (superuser) — CREATE POLICY needs table ownership or
    // superuser, and the role/membership DDL needs CREATEROLE.
    await admin.query(readMigration("0004_tenant_resolver.sql"));
    await admin.query(readMigration("0006_broker_auth.sql"));

    await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);

    const brokerResult = await admin.query<{ id: string }>(
      "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ('Session Lifecycle Broker', 'sl-phone', 'sl-waba') RETURNING id",
    );
    brokerId = brokerResult.rows[0].id;
    const userResult = await admin.query<{ id: string }>(
      "INSERT INTO broker_users (broker_id, name, phone, email) VALUES ($1, 'SL User', 'sl-user-phone', 'sl-user@example.com') RETURNING id",
      [brokerId],
    );
    brokerUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      if (safeToMutate) {
        await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
        await admin.query("CREATE SCHEMA public");
        await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
        await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
        await admin.query("DROP ROLE IF EXISTS dirus_tenant_resolver");
      }
    } finally {
      await admin.end();
    }
  });

  async function seedSession(opts: {
    lastSeenAtSql: string;
    idleExpiresAtSql: string;
  }): Promise<{ rawSession: string; sessionHash: string }> {
    const rawSession = randomBytes(32).toString("base64url");
    const sessionHash = sha256Hex(rawSession);
    await admin.query(
      `insert into sessions (broker_id, broker_user_id, session_token_hash, csrf_token_hash, idle_expires_at, last_seen_at)
       values ($1, $2, $3, $4, ${opts.idleExpiresAtSql}, ${opts.lastSeenAtSql})`,
      [brokerId, brokerUserId, sessionHash, sha256Hex(randomBytes(32).toString("base64url"))],
    );
    return { rawSession, sessionHash };
  }

  it("task 4.9: a session issued 6 days ago, used now, has idle_expires_at extended forward from now — and a session idle 7+ days no longer authenticates", async () => {
    const { resolveSession } = await importRealServices();
    const probeApp = buildProbeApp(resolveSession);

    // "Issued 6 days ago, used daily" (spec 'An active session is renewed
    // on use'): last_seen_at 6 days in the past (well past the 15-minute
    // throttle window), idle_expires_at 1 day from now (about to expire).
    const { rawSession, sessionHash } = await seedSession({
      lastSeenAtSql: "now() - interval '6 days'",
      idleExpiresAtSql: "now() + interval '1 day'",
    });

    const res = await probeApp.request("/probe", {
      headers: { Cookie: `dirus_session=${rawSession}` },
    });
    expect(res.status).toBe(200);

    const row = await admin.query<{ idle_expires_at: Date; last_seen_at: Date }>(
      "select idle_expires_at, last_seen_at from sessions where session_token_hash = $1",
      [sessionHash],
    );
    const idleExpiresAt = row.rows[0].idle_expires_at;
    const lastSeenAt = row.rows[0].last_seen_at;

    // Extended forward from THIS request's time, not the original issuance
    // — comparing by value (.getTime()), per this project's own established
    // lesson (Phase 3 apply-progress.md: `pg` returns `timestamptz` as a
    // `Date`, and `toBe` is reference equality).
    const sixDaysFromNowMs = Date.now() + 6 * 24 * 60 * 60 * 1000;
    expect(idleExpiresAt.getTime()).toBeGreaterThan(sixDaysFromNowMs);
    expect(lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Spec 'A session idle for 7 days no longer authenticates'.
    const { sessionHash: staleHash, rawSession: rawStale } = await seedSession({
      lastSeenAtSql: "now() - interval '8 days'",
      idleExpiresAtSql: "now() - interval '1 day'",
    });
    void staleHash;
    const staleRes = await probeApp.request("/probe", {
      headers: { Cookie: `dirus_session=${rawStale}` },
    });
    expect(staleRes.status).toBe(401);
  });

  it("task 4.10 (NEEDS EMPIRICAL PROOF — design.md Open Question): concurrent authenticated GETs on the same session do not deadlock/serialize-error, and idle_expires_at ends in a consistent state", async () => {
    const { resolveSession } = await importRealServices();
    const probeApp = buildProbeApp(resolveSession);

    const { rawSession, sessionHash } = await seedSession({
      lastSeenAtSql: "now() - interval '20 minutes'",
      idleExpiresAtSql: "now() + interval '1 day'",
    });

    const dispatch = () => probeApp.request("/probe", { headers: { Cookie: `dirus_session=${rawSession}` } });

    // Dispatch pattern is load-bearing — see file header. All five fired
    // before any is awaited to completion.
    const results = await Promise.all([dispatch(), dispatch(), dispatch(), dispatch(), dispatch()]);

    for (const res of results) {
      expect(res.status).toBe(200);
    }

    const row = await admin.query<{ idle_expires_at: Date; last_seen_at: Date }>(
      "select idle_expires_at, last_seen_at from sessions where session_token_hash = $1",
      [sessionHash],
    );
    // A single, well-formed row survives (no duplicate/corrupted state) with
    // a consistent forward-extended expiry.
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].idle_expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });

  it("task 4.13: full end-to-end — real callback issues a session, real logout revokes it, the same cookie is then rejected by a real session-protected request", async () => {
    const services = await importRealServices();
    const {
      createApp,
      resolveBrokerIdByMagicLinkTokenHash,
      consumeMagicLinkToken,
      createSession,
      resolveSession,
      revokeSession,
    } = services;

    const app = createApp({
      ingest: async () => ({ deduplicated: false }),
      resolveBrokerId: async () => null,
      webhookToken: WEBHOOK_TOKEN,
      sendEcho: async () => undefined,
      adminToken: ADMIN_API_TOKEN,
      resolveBrokerExists: async () => true,
      importPolicyRows: async (id: string) => ({
        brokerId: id,
        totals: { rows: 0, inserted: 0, updated: 0, failed: 0 },
        rows: [],
      }),
      resolveBrokerIdByEmail: async () => null,
      issueMagicLinkToken: async () => undefined,
      sendMagicLink: async () => undefined,
      dashboardBaseUrl: "https://app.dirus.io",
      resolveBrokerIdByMagicLinkTokenHash,
      consumeMagicLinkToken,
      createSession,
      resolveSession,
      revokeSession,
      needsReviewQueue: async () => [],
      correctExtraction: async () => ({ found: true }),
    });

    // Seed a real, valid magic_link_tokens row directly (out-of-band seed,
    // mirroring `magic-link-consumption.live.test.ts`'s convention) —
    // 3.15/3.18's real callback path consumes it for real below.
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(rawToken);
    await admin.query(
      "insert into magic_link_tokens (broker_id, broker_user_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '15 minutes')",
      [brokerId, brokerUserId, tokenHash],
    );

    const callbackRes = await app.request(`/auth/callback?token=${rawToken}`);
    expect(callbackRes.status).toBe(302);

    const setCookies = callbackRes.headers.getSetCookie();
    const sessionCookie = setCookies.find((line) => line.startsWith("dirus_session="));
    const csrfCookie = setCookies.find((line) => line.startsWith("dirus_csrf="));
    expect(sessionCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();

    const rawSessionValue = sessionCookie!.split(";")[0]!.split("=")[1]!;
    const rawCsrfValue = csrfCookie!.split(";")[0]!.split("=")[1]!;

    const cookieHeader = `dirus_session=${rawSessionValue}; dirus_csrf=${rawCsrfValue}`;

    const logoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: cookieHeader, "X-Dirus-CSRF": rawCsrfValue },
    });
    expect(logoutRes.status).toBeLessThan(300);

    // The same cookie, presented afterward, is rejected — through the SAME
    // real `resolveSession` the app itself uses (not a fake, per task
    // 4.13's "full end-to-end" instruction).
    const probeApp = buildProbeApp(resolveSession);
    const rejectedRes = await probeApp.request("/probe", { headers: { Cookie: `dirus_session=${rawSessionValue}` } });
    expect(rejectedRes.status).toBe(401);
  });
});
