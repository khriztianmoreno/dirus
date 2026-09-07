import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `admin-dashboard` (C1) task 5.13 (RED then GREEN, live), extraction-review
 * spec "A resolved extraction disappears from the queue". Runs against
 * SEEDED FIXTURE `extractions` rows, not real extractions — no real
 * producer exists yet (B2, `ingestion-agent`, hasn't landed; per this
 * change's proposal, this phase's testing approach is explicitly seeded
 * fixtures, mirroring Phase 6's own "seeded fixtures and empty tables"
 * convention for the same reason).
 *
 * **Convention: reuses the shared `LIVE_TEST_DATABASE_URL` throwaway-schema
 * convention (`import-policies.live.test.ts`'s Phase-5-of-`policy-bulk-
 * import` precedent), NOT a new dedicated database.** `extractions` and
 * `withBrokerContext` need no `SECURITY DEFINER` function whose body
 * hardcodes `public.*` — that is the ONLY reason
 * `broker-auth`/`session-lifecycle` needed their own dedicated database
 * (see `apply-progress.md` Phase 4's own record and this file's own CI
 * wiring note). `needsReviewQueue`/`correctExtraction` are plain
 * `withBrokerContext`-scoped table reads/writes, so the shared throwaway-
 * schema convention applies cleanly. **No new CI database was added for
 * this test** — see `apply-progress.md` Phase 5 section for the explicit
 * statement.
 *
 * **Single role, no RLS applied** — mirrors `import-policies.live.test.ts`'s
 * own documented reasoning ("Why one role, not an OWNER/APP split"): this
 * task has no cross-tenant/RLS-crossing assertion to make (that would be a
 * separate isolation proof, out of this phase's scope), only "does a
 * resolved extraction leave the queue for its OWN broker" — a single
 * throwaway login role with a real, disposable connection is sufficient.
 *
 * **Real `needsReviewQueue`/`correctExtraction` through a real HTTP route**
 * (`registerReviewQueueRoute`), NOT `session-auth.ts`'s real
 * `resolveSession` — this suite's own scope is the review-queue capability
 * (tasks 5.6-5.12), not session resolution, which already has its own live
 * proof (`session-lifecycle.live.test.ts`, Phase 4). A minimal pass-through
 * middleware sets `c.var.brokerId`/`c.var.session` from a fixed seeded
 * broker/broker_user, mirroring `review-queue.test.ts`'s (offline) own
 * stand-in convention.
 *
 * **No redundant `SET search_path` re-prepending** (Phase 3's hard-won
 * lesson, `apply-progress.md`): the throwaway role's `search_path` is set
 * once via `ALTER ROLE ... SET search_path`, and no statement in this file
 * additionally issues a bare `SET search_path` on top of it.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable
 * (verified: `nc -z localhost 5432` closed, no `docker`/`podman`/`psql`
 * binary on PATH). `LIVE_TEST_DATABASE_URL` is unset here, so this entire
 * suite reports SKIPPED, not run. It must execute in CI.
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../packages/db/migrations/${file}`, import.meta.url)),
    "utf8",
  );
}

function randomThrowawaySchemaName(): string {
  return `review_queue_live_${randomBytes(6).toString("hex")}`;
}

/** Same rewrite `packages/db/test/migrations/throwaway-schema.ts` performs, duplicated locally (see file header, F2/Phase 5 precedent). */
function rewriteSchemaQualification(sqlText: string, schema: string): string {
  return sqlText.replaceAll('"public".', `"${schema}".`);
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

const APP_ROLE = "review_queue_live_app";
const APP_PASSWORD = "review-queue-live-app-pass";

type ProbeVariables = { brokerId: string; session: { brokerUserId: string } };

/**
 * `@dirus/db`'s internal client reads `DATABASE_URL` at import time —
 * mirrors `import-policies.live.test.ts`'s/`session-lifecycle.live.test.ts`'s
 * identical `vi.resetModules()` + fresh-import convention.
 */
async function importRealServices() {
  vi.resetModules();
  process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
  process.env.ALLOW_UNPOOLED_RUNTIME = "1";

  const { needsReviewQueue } = await import("../../src/services/queries/needs-review-queue.js");
  const { correctExtraction } = await import("../../src/services/queries/correct-extraction.js");
  const { registerReviewQueueRoute } = await import("../../src/routes/dashboard/review-queue.js");

  return { needsReviewQueue, correctExtraction, registerReviewQueueRoute };
}

function buildProbeApp(
  services: Awaited<ReturnType<typeof importRealServices>>,
  session: { brokerId: string; brokerUserId: string },
) {
  const app = new Hono<{ Variables: ProbeVariables }>();
  app.use("*", async (c, next) => {
    c.set("brokerId", session.brokerId);
    c.set("session", { brokerUserId: session.brokerUserId });
    await next();
  });
  // `registerReviewQueueRoute`'s `AppVariables` type is a superset of
  // `ProbeVariables` in the fields it actually reads (`brokerId`,
  // `session.brokerUserId`) — cast is safe: the route never reads any
  // other `AppVariables` member.
  services.registerReviewQueueRoute(app as unknown as Parameters<typeof services.registerReviewQueueRoute>[0], {
    needsReviewQueue: services.needsReviewQueue,
    correctExtraction: services.correctExtraction,
  });
  return app;
}

describe.skipIf(!liveUrl)("review queue — live, seeded-fixture (task 5.13)", () => {
  let admin: Client;
  let schema: string;
  let safeToMutate = false;
  let brokerId: string;
  let brokerUserId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    await assertThrowawayDatabase(admin);

    await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);

    schema = randomThrowawaySchemaName();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    safeToMutate = true;

    await admin.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CREATE, USAGE ON SCHEMA "${schema}" TO ${APP_ROLE}`);
    await admin.query(`ALTER ROLE ${APP_ROLE} SET search_path TO "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);

    // Applied as `admin` (superuser), owned by `admin` — no RLS applied at
    // all in this suite (see file header, "Why one role, not an OWNER/APP
    // split"), so no separate OWNER role is needed.
    await admin.query(rewriteSchemaQualification(readMigration("0000_init.sql"), schema));
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}`);

    const brokerResult = await admin.query<{ id: string }>(
      `INSERT INTO "${schema}".brokers (name, wa_phone_number_id, waba_id) VALUES ('Review Queue Live Broker', 'rq-phone', 'rq-waba') RETURNING id`,
    );
    brokerId = brokerResult.rows[0].id;
    // No `email` column here — this suite applies only `0000_init.sql`
    // (see the comment above: no RLS, so 0002 isn't needed either), and
    // `email` only exists on `broker_users` after migration `0006`, which
    // this suite has no reason to apply (nothing here exercises broker-auth
    // or its SECURITY DEFINER functions). CI's first run of this file
    // proved that directly: "column email of relation broker_users does
    // not exist". This row exists only to satisfy `extractions.corrected_by`'s
    // FK — it needs no email.
    const userResult = await admin.query<{ id: string }>(
      `INSERT INTO "${schema}".broker_users (broker_id, name, phone) VALUES ($1, 'RQ User', 'rq-user-phone') RETURNING id`,
      [brokerId],
    );
    brokerUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      if (safeToMutate) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      }
    } finally {
      await admin.end();
    }
  });

  it(
    "5.13: a flagged extraction fixture row, after a real correction call, has needs_review = false, correctedOutput/correctedBy " +
      "populated, and no longer appears in a subsequent real call to the list endpoint",
    async () => {
      const services = await importRealServices();
      const app = buildProbeApp(services, { brokerId, brokerUserId });

      const extractionResult = await admin.query<{ id: string }>(
        `INSERT INTO "${schema}".extractions (broker_id, model, output, confidence, needs_review)
         VALUES ($1, 'gemini-3.1-flash', $2, $3, true) RETURNING id`,
        [
          brokerId,
          JSON.stringify({ policyNumber: "POL-999", endDate: "2027-01-01" }),
          JSON.stringify({ policyNumber: 0.92, endDate: 0.61 }),
        ],
      );
      const extractionId = extractionResult.rows[0].id;

      // Before: the fixture row is in the queue.
      const beforeRes = await app.request("/dashboard/review-queue");
      expect(beforeRes.status).toBe(200);
      const beforeBody = (await beforeRes.json()) as { rows: Array<{ id: string }> };
      expect(beforeBody.rows.map((r) => r.id)).toContain(extractionId);

      // The real correction call.
      const correctionRes = await app.request(`/dashboard/review-queue/${extractionId}/correction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correctedOutput: { endDate: "2027-06-30" } }),
      });
      expect(correctionRes.status).toBe(200);

      // Direct DB assertion: needs_review is false, correctedOutput/correctedBy populated.
      const row = await admin.query<{
        needs_review: boolean;
        corrected_output: unknown;
        corrected_by: string | null;
      }>(
        `SELECT needs_review, corrected_output, corrected_by FROM "${schema}".extractions WHERE id = $1`,
        [extractionId],
      );
      expect(row.rows[0].needs_review).toBe(false);
      expect(row.rows[0].corrected_output).toEqual({ endDate: "2027-06-30" });
      expect(row.rows[0].corrected_by).toBe(brokerUserId);

      // A subsequent real call to the list endpoint no longer includes it.
      const afterRes = await app.request("/dashboard/review-queue");
      expect(afterRes.status).toBe(200);
      const afterBody = (await afterRes.json()) as { rows: Array<{ id: string }> };
      expect(afterBody.rows.map((r) => r.id)).not.toContain(extractionId);
    },
  );
});
