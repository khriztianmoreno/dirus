import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `admin-dashboard` (C1) tasks 6.3 and 6.6 (RED then GREEN, live),
 * product-metrics spec "The copilot-usage metric changes when a copilot
 * conversation is added" and "The renewal-funnel metric changes when a
 * renewal's status changes" — **the exact-delta assertion the task brief
 * requires, not a weak "returns 200"**: insert one row, call the metric,
 * record the count as `M`/`N`; insert exactly one more; call again; assert
 * the returned count is precisely `M + 1`/`N + 1`, never merely "changed"
 * or "increased". This is the discriminating live-query proof the task
 * brief calls out as the place a weak assertion would silently lose the
 * spec's intent — the same discriminating pattern this project has
 * required since `policy-bulk-import`'s and `whatsapp-webhook-ingress`'s
 * own metric/count-changes-on-insert tests.
 *
 * **Convention: reuses `review-queue.live.test.ts`'s (Phase 5) shared
 * throwaway-schema convention** — single role, no RLS, only
 * `0000_init.sql` applied. Neither `conversations` nor `renewals` needs a
 * `SECURITY DEFINER` resolver function (that is the only reason
 * `broker-auth`/`session-lifecycle` needed their own dedicated database —
 * see that file's own header) and this suite makes no cross-tenant/RLS
 * assertion (that is Phase 8's scope), so the shared throwaway-schema
 * convention applies cleanly here too. **No new CI database is added for
 * this suite** — see `apply-progress.md` Phase 6 section.
 *
 * **Migration set checked before writing any seed insert, per this
 * phase's own explicit brief**: `conversations` and `renewals` are both
 * fully defined in `0000_init.sql` (broker-scoped tables with no
 * broker-auth/`email` dependency) — this suite applies ONLY that file,
 * exactly like `review-queue.live.test.ts` and for the identical reason:
 * `broker_users.email` (migration `0006`) is never referenced by any
 * insert below.
 *
 * **Calls the real metric functions directly** (`copilotShare`,
 * `renewalStatus`), through a real `withBrokerContext` call opened by this
 * test the same way `apps/api/src/index.ts`'s wiring will (task 6.16's
 * reentrancy-guard note: the metric function itself never opens its own),
 * rather than through the HTTP route — the route is a thin pass-through
 * over these same functions (offline-tested in `metrics.test.ts`), so
 * exercising the query functions directly against a real Postgres is the
 * precise thing this live proof needs to cover.
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
  return `metrics_live_${randomBytes(6).toString("hex")}`;
}

/** Same rewrite `packages/db/test/migrations/throwaway-schema.ts` performs, duplicated locally (see `review-queue.live.test.ts`'s identical header note). */
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

const APP_ROLE = "metrics_live_app";
const APP_PASSWORD = "metrics-live-app-pass";

/**
 * `@dirus/db`'s internal client reads `DATABASE_URL` at import time —
 * mirrors `review-queue.live.test.ts`'s/`policies-import.live.test.ts`'s
 * identical `vi.resetModules()` + fresh-import convention.
 */
async function importRealServices() {
  vi.resetModules();
  process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
  process.env.ALLOW_UNPOOLED_RUNTIME = "1";

  const { withBrokerContext } = await import("@dirus/db");
  const { copilotShare } = await import("../../src/services/metrics/copilot-share.js");
  const { renewalStatus } = await import("../../src/services/metrics/renewal-status.js");

  return { withBrokerContext, copilotShare, renewalStatus };
}

describe.skipIf(!liveUrl)("metrics — live, exact-delta (tasks 6.3, 6.6)", () => {
  let admin: Client;
  let schema: string;
  let safeToMutate = false;
  let brokerId: string;
  let contactId: string;
  let policyId: string;

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

    // No RLS applied in this suite (see file header) — 0000_init.sql only.
    await admin.query(rewriteSchemaQualification(readMigration("0000_init.sql"), schema));
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}`);

    const brokerResult = await admin.query<{ id: string }>(
      `INSERT INTO "${schema}".brokers (name, wa_phone_number_id, waba_id) VALUES ('Metrics Live Broker', 'metrics-phone', 'metrics-waba') RETURNING id`,
    );
    brokerId = brokerResult.rows[0].id;

    const contactResult = await admin.query<{ id: string }>(
      `INSERT INTO "${schema}".contacts (broker_id, phone) VALUES ($1, 'metrics-contact-phone') RETURNING id`,
      [brokerId],
    );
    contactId = contactResult.rows[0].id;

    const policyResult = await admin.query<{ id: string }>(
      `INSERT INTO "${schema}".policies (broker_id, contact_id, insurer, line, policy_number, end_date)
       VALUES ($1, $2, 'Sura', 'auto', 'POL-METRICS-1', '2027-01-01') RETURNING id`,
      [brokerId, contactId],
    );
    policyId = policyResult.rows[0].id;
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
    "6.3: inserting one copilot conversation moves copilotShare's count by exactly +1, twice in a row",
    async () => {
      const services = await importRealServices();

      const before = await services.withBrokerContext(brokerId, services.copilotShare);
      const m = before.value.count;

      await admin.query(
        `INSERT INTO "${schema}".conversations (broker_id, kind) VALUES ($1, 'copilot')`,
        [brokerId],
      );

      const afterFirstInsert = await services.withBrokerContext(brokerId, services.copilotShare);
      expect(afterFirstInsert.value.count).toBe(m + 1);

      await admin.query(
        `INSERT INTO "${schema}".conversations (broker_id, kind) VALUES ($1, 'copilot')`,
        [brokerId],
      );

      const afterSecondInsert = await services.withBrokerContext(brokerId, services.copilotShare);
      expect(afterSecondInsert.value.count).toBe(m + 2);
    },
  );

  it(
    "6.6: inserting one 'paid' renewal moves renewalStatus's paid count by exactly +1, twice in a row",
    async () => {
      const services = await importRealServices();

      const before = await services.withBrokerContext(brokerId, services.renewalStatus);
      const n = before.value.paid ?? 0;

      await admin.query(
        `INSERT INTO "${schema}".renewals (broker_id, policy_id, due_date, status) VALUES ($1, $2, '2027-02-01', 'paid')`,
        [brokerId, policyId],
      );

      const afterFirstInsert = await services.withBrokerContext(brokerId, services.renewalStatus);
      expect(afterFirstInsert.value.paid).toBe(n + 1);

      await admin.query(
        `INSERT INTO "${schema}".renewals (broker_id, policy_id, due_date, status) VALUES ($1, $2, '2027-03-01', 'paid')`,
        [brokerId, policyId],
      );

      const afterSecondInsert = await services.withBrokerContext(brokerId, services.renewalStatus);
      expect(afterSecondInsert.value.paid).toBe(n + 2);
    },
  );
});
