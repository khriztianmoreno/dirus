import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `admin-dashboard` (C1) Phase 8 (tasks 8.1-8.4), design.md D-A's fifth
 * live assertion ("Cross-tenant, end-to-end (the non-negotiable success
 * criterion)") and proposal Success Criteria "Non-negotiable: a live test
 * proves an authenticated broker A session cannot read broker B's
 * extractions, renewals, or metrics — with a positive control proving the
 * assertion is not vacuous."
 *
 * **Real end-to-end login, not a stand-in middleware** — unlike
 * `review-queue.live.test.ts` (Phase 5, its own scope was the review-queue
 * capability, not session resolution), this suite drives a real broker-A
 * session through the ACTUAL routes: `POST /auth/magic-link` (with a
 * test-double `sendMagicLink` that captures the dispatched URL instead of
 * really emailing it, mirroring `magic-link.test.ts`'s established
 * offline-fake convention), then `GET /auth/callback?token=...` (the real
 * `consumeMagicLinkToken`/`createSession`), extracting the real
 * `dirus_session`/`dirus_csrf` `Set-Cookie` values and presenting them on
 * every subsequent request — exactly `session-lifecycle.live.test.ts`'s
 * task 4.13 pattern, reused here for a full round trip through
 * `createApp` rather than a private probe app, because this suite's own
 * job is proving the REAL dashboard routes (review-queue, all six
 * metrics, `/auth/me`) respect that session's `brokerId`, not merely that
 * `resolveSession` itself works (already proven live by task 4.9/4.13).
 *
 * **Own dedicated database** (`CROSS_TENANT_ISOLATION_TEST_DATABASE_URL`),
 * mirroring `session-lifecycle.live.test.ts`'s file header exactly:
 * `0006_broker_auth.sql`'s three `SECURITY DEFINER` function bodies
 * hardcode `public.*` (the search_path-hijack defense), so they cannot run
 * against a randomly-named throwaway schema — this suite needs all of
 * 0000/0002/0004/0006 applied to a real `public` schema, full teardown in
 * `afterAll`. **Its own database, not the shared `session-lifecycle` one**:
 * `vitest.config.ts`'s `fileParallelism: false` (added on this branch after
 * two real CI collisions on the cluster-global `dirus_app` role name)
 * already makes every live file in this directory run sequentially, so a
 * second dedicated database is not needed to avoid a `dirus_app` race —
 * it is needed so this suite's own extractions/renewals/conversations
 * fixture rows (task 8.1-8.3) never share a database with, or get
 * torn down by, `session-lifecycle.live.test.ts`'s own independent
 * sessions/tokens lifecycle.
 *
 * **Seeding convention**: broker A/B fixture rows (`brokers`,
 * `broker_users`, `contacts`, `policies`, `conversations`, `extractions`,
 * `renewals`, `messages`) are inserted directly by `admin` (the seeding
 * superuser client), never through `withBrokerContext` — task brief's own
 * instruction: `withBrokerContext`'s reentrancy guard forbids nesting a
 * second call inside another's callback, so seeding BOTH brokers can never
 * go through that helper sequentially-nested; direct SQL as the seeding
 * admin sidesteps the guard entirely rather than fighting it.
 *
 * **Set-emptiness proof, not exact-delta**: every assertion below compares
 * broker A's response to its OWN known fixture counts/ids, chosen to be
 * DISTINCT from broker B's (different counts, overlapping-but-not-equal
 * status labels, a template-message offset that would shift the result by
 * a different number of days if it leaked) — so a leak would fail the
 * assertion with a wrong value/extra id, never silently pass a vacuous
 * "is defined" check.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable
 * (verified: `nc -z localhost 5432` closed, no `docker`/`podman`/`psql`
 * binary on PATH). `CROSS_TENANT_ISOLATION_TEST_DATABASE_URL` is unset
 * here, so this entire suite reports SKIPPED, not run. It must execute in
 * CI.
 */
const liveUrl = process.env.CROSS_TENANT_ISOLATION_TEST_DATABASE_URL;

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

const OWNER_ROLE = "cross_tenant_isolation_owner";
const OWNER_PASSWORD = "cross-tenant-isolation-owner-pass";
const APP_ROLE = "dirus_app";
const APP_PASSWORD = "cross-tenant-isolation-app-pass";
const WEBHOOK_TOKEN = "w".repeat(32);
const ADMIN_API_TOKEN = "a".repeat(32);
const DASHBOARD_BASE_URL = "https://app.dirus.io";

/**
 * `@dirus/db`'s internal client reads `DATABASE_URL` at import time —
 * mirrors `session-lifecycle.live.test.ts`'s identical `vi.resetModules()`
 * + fresh-import convention.
 */
async function importRealServices() {
  vi.resetModules();
  process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
  process.env.ALLOW_UNPOOLED_RUNTIME = "1";

  const { withBrokerContext, resolveBrokerIdByEmail, resolveBrokerIdByMagicLinkTokenHash } = await import(
    "@dirus/db"
  );
  const { issueMagicLinkToken } = await import("../../src/services/auth/issue-magic-link.js");
  const { consumeMagicLinkToken } = await import("../../src/services/auth/consume-magic-link.js");
  const { createSession } = await import("../../src/services/auth/create-session.js");
  const { resolveSession } = await import("../../src/services/auth/resolve-session.js");
  const { revokeSession } = await import("../../src/services/auth/revoke-session.js");
  const { needsReviewQueue } = await import("../../src/services/queries/needs-review-queue.js");
  const { correctExtraction } = await import("../../src/services/queries/correct-extraction.js");
  const { copilotShare } = await import("../../src/services/metrics/copilot-share.js");
  const { renewalStatus } = await import("../../src/services/metrics/renewal-status.js");
  const { needsReviewRate } = await import("../../src/services/metrics/needs-review-rate.js");
  const { conversationStatusSnapshot } = await import("../../src/services/metrics/conversation-status-snapshot.js");
  const { timeToFirstRenewal } = await import("../../src/services/metrics/time-to-first-renewal.js");
  const { costMetric } = await import("../../src/services/metrics/cost.js");
  const { createApp } = await import("../../src/app.js");

  return {
    withBrokerContext,
    resolveBrokerIdByEmail,
    resolveBrokerIdByMagicLinkTokenHash,
    issueMagicLinkToken,
    consumeMagicLinkToken,
    createSession,
    resolveSession,
    revokeSession,
    needsReviewQueue,
    correctExtraction,
    copilotShare,
    renewalStatus,
    needsReviewRate,
    conversationStatusSnapshot,
    timeToFirstRenewal,
    costMetric,
    createApp,
  };
}

function buildRealApp(services: Awaited<ReturnType<typeof importRealServices>>, sendMagicLink: (to: string, url: string) => Promise<void>) {
  return services.createApp({
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
    resolveBrokerIdByEmail: services.resolveBrokerIdByEmail,
    issueMagicLinkToken: services.issueMagicLinkToken,
    sendMagicLink,
    dashboardBaseUrl: DASHBOARD_BASE_URL,
    resolveBrokerIdByMagicLinkTokenHash: services.resolveBrokerIdByMagicLinkTokenHash,
    consumeMagicLinkToken: services.consumeMagicLinkToken,
    createSession: services.createSession,
    resolveSession: services.resolveSession,
    revokeSession: services.revokeSession,
    needsReviewQueue: services.needsReviewQueue,
    correctExtraction: services.correctExtraction,
    metrics: {
      copilotShare: (brokerId: string) => services.withBrokerContext(brokerId, services.copilotShare),
      renewalStatus: (brokerId: string) => services.withBrokerContext(brokerId, services.renewalStatus),
      needsReviewRate: (brokerId: string) => services.withBrokerContext(brokerId, services.needsReviewRate),
      conversationStatusSnapshot: (brokerId: string) =>
        services.withBrokerContext(brokerId, services.conversationStatusSnapshot),
      timeToFirstRenewal: (brokerId: string) => services.withBrokerContext(brokerId, services.timeToFirstRenewal),
      cost: () => services.costMetric(null),
    },
  });
}

/**
 * Drives the REAL `POST /auth/magic-link` -> real (test-double)
 * `sendMagicLink` capture -> real `GET /auth/callback?token=...` -> real
 * `Set-Cookie` extraction round trip (task 8.4). Returns the cookie header
 * string every subsequent authenticated request in this suite presents.
 */
async function realLoginJourney(
  app: ReturnType<typeof buildRealApp>,
  email: string,
  capturedUrls: string[],
): Promise<{ cookieHeader: string; csrfToken: string }> {
  const requestRes = await app.request("/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(requestRes.status).toBe(202);
  await requestRes.text();

  // The route dispatches `sendMagicLink` detached (`void sendMagicLink(...)`,
  // never awaited by the route itself) but the injected test-double below
  // captures the URL synchronously inside its own function body, before
  // returning its resolved promise — mirroring `magic-link.test.ts`'s own
  // "await res.text(), then assert the spy was called" convention, which
  // relies on the identical synchronous-capture shape.
  const dispatchedUrl = capturedUrls.at(-1);
  expect(dispatchedUrl).toBeTruthy();
  const rawToken = new URL(dispatchedUrl!).searchParams.get("token");
  expect(rawToken).toBeTruthy();

  const callbackRes = await app.request(`/auth/callback?token=${rawToken}`);
  expect(callbackRes.status).toBe(302);

  const setCookies = callbackRes.headers.getSetCookie();
  const sessionCookie = setCookies.find((line) => line.startsWith("dirus_session="));
  const csrfCookie = setCookies.find((line) => line.startsWith("dirus_csrf="));
  expect(sessionCookie).toBeTruthy();
  expect(csrfCookie).toBeTruthy();

  const rawSessionValue = sessionCookie!.split(";")[0]!.split("=")[1]!;
  const rawCsrfValue = csrfCookie!.split(";")[0]!.split("=")[1]!;

  return {
    cookieHeader: `dirus_session=${rawSessionValue}; dirus_csrf=${rawCsrfValue}`,
    csrfToken: rawCsrfValue,
  };
}

describe.skipIf(!liveUrl)("cross-tenant isolation — live, end-to-end (tasks 8.1-8.4)", () => {
  let admin: Client;
  let safeToMutate = false;

  let brokerAId: string;
  let brokerBId: string;
  const brokerAEmail = "cti-a@example.com";

  let extractionA1Id: string; // needs_review = true — positive control (review queue + needs-review-rate)
  let extractionB1Id: string;
  let extractionB2Id: string;
  let extractionB3Id: string;

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

    // 0004 creates dirus_tenant_resolver (extended by 0006); both applied as
    // admin (superuser) — CREATE POLICY needs table ownership or superuser,
    // and the role/membership DDL needs CREATEROLE.
    await admin.query(readMigration("0004_tenant_resolver.sql"));
    await admin.query(readMigration("0006_broker_auth.sql"));

    await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);

    // ---- Broker A fixture (small, distinct counts/statuses/timestamps) ----
    const brokerAResult = await admin.query<{ id: string }>(
      `insert into brokers (name, wa_phone_number_id, waba_id, created_at)
       values ('Cross Tenant Broker A', 'cti-a-phone', 'cti-a-waba', now() - interval '10 days')
       returning id`,
    );
    brokerAId = brokerAResult.rows[0].id;

    await admin.query(
      `insert into broker_users (broker_id, name, phone, email) values ($1, 'CTI User A', 'cti-a-user-phone', $2)`,
      [brokerAId, brokerAEmail],
    );

    const contactAResult = await admin.query<{ id: string }>(
      `insert into contacts (broker_id, phone) values ($1, 'cti-a-contact-phone') returning id`,
      [brokerAId],
    );
    const contactAId = contactAResult.rows[0].id;

    const policyAResult = await admin.query<{ id: string }>(
      `insert into policies (broker_id, contact_id, insurer, line, policy_number, end_date)
       values ($1, $2, 'Sura', 'auto', 'POL-CTI-A-1', '2027-01-01') returning id`,
      [brokerAId, contactAId],
    );
    const policyAId = policyAResult.rows[0].id;

    // 2 copilot conversations (positive control for copilotShare = 2) + 1
    // whatsapp/resolved conversation (carries the template message below,
    // and diversifies the status snapshot).
    await admin.query(
      `insert into conversations (broker_id, kind, status) values ($1, 'copilot', 'bot'), ($1, 'copilot', 'bot')`,
      [brokerAId],
    );
    const conversationA3Result = await admin.query<{ id: string }>(
      `insert into conversations (broker_id, kind, status) values ($1, 'whatsapp', 'resolved') returning id`,
      [brokerAId],
    );
    const conversationA3Id = conversationA3Result.rows[0].id;

    // Template message exactly 7 days after brokers.created_at (now() - 10
    // days -> template at now() - 3 days) — the discriminating value
    // time-to-first-renewal must return for broker A, not broker B's own
    // (deliberately different) offset.
    await admin.query(
      `insert into messages (broker_id, conversation_id, direction, sender, type, created_at)
       values ($1, $2, 'outbound', 'bot', 'template', now() - interval '3 days')`,
      [brokerAId, conversationA3Id],
    );

    // extractions: 1 flagged (positive control for review-queue + needs-review-rate), 1 not.
    const extractionA1Result = await admin.query<{ id: string }>(
      `insert into extractions (broker_id, model, output, confidence, needs_review)
       values ($1, 'gemini-3.1-flash', $2, $3, true) returning id`,
      [brokerAId, JSON.stringify({ policyNumber: "POL-CTI-A-1" }), JSON.stringify({ policyNumber: 0.9 })],
    );
    extractionA1Id = extractionA1Result.rows[0].id;
    await admin.query(
      `insert into extractions (broker_id, model, output, confidence, needs_review)
       values ($1, 'gemini-3.1-flash', $2, $3, false)`,
      [brokerAId, JSON.stringify({ policyNumber: "POL-CTI-A-1" }), JSON.stringify({ policyNumber: 0.99 })],
    );

    // renewals: 1 paid, 1 pending.
    await admin.query(
      `insert into renewals (broker_id, policy_id, due_date, status)
       values ($1, $2, '2027-02-01', 'paid'), ($1, $2, '2027-03-01', 'pending')`,
      [brokerAId, policyAId],
    );

    // ---- Broker B fixture (deliberately larger, overlapping status labels) ----
    const brokerBResult = await admin.query<{ id: string }>(
      `insert into brokers (name, wa_phone_number_id, waba_id, created_at)
       values ('Cross Tenant Broker B', 'cti-b-phone', 'cti-b-waba', now() - interval '100 days')
       returning id`,
    );
    brokerBId = brokerBResult.rows[0].id;

    await admin.query(
      `insert into broker_users (broker_id, name, phone, email) values ($1, 'CTI User B', 'cti-b-user-phone', 'cti-b@example.com')`,
      [brokerBId],
    );

    const contactBResult = await admin.query<{ id: string }>(
      `insert into contacts (broker_id, phone) values ($1, 'cti-b-contact-phone') returning id`,
      [brokerBId],
    );
    const contactBId = contactBResult.rows[0].id;

    const policyBResult = await admin.query<{ id: string }>(
      `insert into policies (broker_id, contact_id, insurer, line, policy_number, end_date)
       values ($1, $2, 'Sura', 'auto', 'POL-CTI-B-1', '2027-01-01') returning id`,
      [brokerBId, contactBId],
    );
    const policyBId = policyBResult.rows[0].id;

    // 5 copilot conversations + 2 escalated whatsapp conversations.
    await admin.query(
      `insert into conversations (broker_id, kind, status)
       values ($1, 'copilot', 'bot'), ($1, 'copilot', 'bot'), ($1, 'copilot', 'bot'),
              ($1, 'copilot', 'bot'), ($1, 'copilot', 'bot')`,
      [brokerBId],
    );
    const conversationBEscalatedResult = await admin.query<{ id: string }>(
      `insert into conversations (broker_id, kind, status)
       values ($1, 'whatsapp', 'escalated'), ($1, 'whatsapp', 'escalated') returning id`,
      [brokerBId],
    );
    const conversationB1Id = conversationBEscalatedResult.rows[0].id;

    // Template message 99 days after brokers.created_at (now() - 100 days ->
    // template at now() - 1 day) — a completely different day-count from
    // broker A's 7, so a leaked value fails loudly rather than coincidentally.
    await admin.query(
      `insert into messages (broker_id, conversation_id, direction, sender, type, created_at)
       values ($1, $2, 'outbound', 'bot', 'template', now() - interval '1 day')`,
      [brokerBId, conversationB1Id],
    );

    // extractions: 3 flagged, 1 not.
    const extractionBRows = await admin.query<{ id: string }>(
      `insert into extractions (broker_id, model, output, confidence, needs_review)
       values ($1, 'gemini-3.1-flash', $2, $3, true),
              ($1, 'gemini-3.1-flash', $2, $3, true),
              ($1, 'gemini-3.1-flash', $2, $3, true),
              ($1, 'gemini-3.1-flash', $2, $3, false)
       returning id`,
      [brokerBId, JSON.stringify({ policyNumber: "POL-CTI-B-1" }), JSON.stringify({ policyNumber: 0.5 })],
    );
    [extractionB1Id, extractionB2Id, extractionB3Id] = extractionBRows.rows.map((r) => r.id);

    // renewals: 3 paid, 2 pending.
    await admin.query(
      `insert into renewals (broker_id, policy_id, due_date, status)
       values ($1, $2, '2027-04-01', 'paid'), ($1, $2, '2027-05-01', 'paid'), ($1, $2, '2027-06-01', 'paid'),
              ($1, $2, '2027-07-01', 'pending'), ($1, $2, '2027-08-01', 'pending')`,
      [brokerBId, policyBId],
    );
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

  /** Shared by every `it()` below — one real login per test (each gets a fresh app/module state via `importRealServices`). */
  async function loginBrokerA() {
    const services = await importRealServices();
    const capturedUrls: string[] = [];
    const sendMagicLink = async (_to: string, url: string) => {
      capturedUrls.push(url);
    };
    const app = buildRealApp(services, sendMagicLink);
    const { cookieHeader } = await realLoginJourney(app, brokerAEmail, capturedUrls);
    return { app, cookieHeader };
  }

  it("task 8.1: an authenticated broker-A session reads zero of broker B's extractions via the real review-queue endpoint, with a positive control that broker A's own flagged extraction IS visible", async () => {
    const { app, cookieHeader } = await loginBrokerA();

    const res = await app.request("/dashboard/review-queue", { headers: { Cookie: cookieHeader } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    const ids = body.rows.map((r) => r.id);

    // Positive control: broker A's own flagged extraction IS in the response.
    expect(ids).toContain(extractionA1Id);

    // Negative (the actual isolation proof): NONE of broker B's flagged
    // extractions leak into broker A's session — an explicit set-emptiness
    // check against every seeded broker-B id, not a vacuous "array is
    // shorter" assumption.
    for (const brokerBExtractionId of [extractionB1Id, extractionB2Id, extractionB3Id]) {
      expect(ids).not.toContain(brokerBExtractionId);
    }
  });

  it("task 8.2: an authenticated broker-A session's renewal-status metric reflects only broker A's own renewals, with a positive control that broker A's own paid/pending counts ARE present", async () => {
    const { app, cookieHeader } = await loginBrokerA();

    const res = await app.request("/dashboard/metrics/renewal-status", { headers: { Cookie: cookieHeader } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: Record<string, number> };

    // Positive control: broker A's own known counts are present.
    expect(body.value.paid).toBe(1);
    expect(body.value.pending).toBe(1);

    // Negative: if broker B's 3 paid / 2 pending renewals had leaked in,
    // these would read 4 / 3 instead — the exact value IS the isolation
    // proof, not merely "the response is non-empty".
    expect(body.value.paid).not.toBe(4);
    expect(body.value.pending).not.toBe(3);
  });

  it("task 8.3: an authenticated broker-A session reads zero of broker B's data across all six metric endpoints in one sweep, each with its own positive control", async () => {
    const { app, cookieHeader } = await loginBrokerA();
    const headers = { Cookie: cookieHeader };

    const [copilotShareRes, renewalStatusRes, needsReviewRateRes, snapshotRes, timeToFirstRenewalRes, costRes] =
      await Promise.all([
        app.request("/dashboard/metrics/copilot-share", { headers }),
        app.request("/dashboard/metrics/renewal-status", { headers }),
        app.request("/dashboard/metrics/needs-review-rate", { headers }),
        app.request("/dashboard/metrics/conversation-status-snapshot", { headers }),
        app.request("/dashboard/metrics/time-to-first-renewal", { headers }),
        app.request("/dashboard/metrics/cost", { headers }),
      ]);

    for (const res of [
      copilotShareRes,
      renewalStatusRes,
      needsReviewRateRes,
      snapshotRes,
      timeToFirstRenewalRes,
      costRes,
    ]) {
      expect(res.status).toBe(200);
    }

    // 1. copilot-share — positive: broker A's own 2 copilot conversations
    // count; negative: not 7 (2 + broker B's 5).
    const copilotShareBody = (await copilotShareRes.json()) as { value: { count: number } };
    expect(copilotShareBody.value.count).toBe(2);
    expect(copilotShareBody.value.count).not.toBe(7);

    // 2. renewal-status — same assertion shape as task 8.2, repeated here
    // for the one-sweep requirement.
    const renewalStatusBody = (await renewalStatusRes.json()) as { value: Record<string, number> };
    expect(renewalStatusBody.value.paid).toBe(1);
    expect(renewalStatusBody.value.pending).toBe(1);

    // 3. needs-review-rate — positive: broker A's own 1 flagged / 2 total;
    // negative: not broker B's 3 flagged / 4 total (nor the 4/6 union).
    const needsReviewRateBody = (await needsReviewRateRes.json()) as {
      value: { flagged: number; total: number; rate: number };
    };
    expect(needsReviewRateBody.value).toEqual({ flagged: 1, total: 2, rate: 0.5 });

    // 4. conversation-status-snapshot — positive: broker A's own {bot: 2,
    // resolved: 1}; negative: broker B's `escalated` status never appears
    // in broker A's distribution at all.
    const snapshotBody = (await snapshotRes.json()) as { value: Record<string, number> };
    expect(snapshotBody.value).toEqual({ bot: 2, resolved: 1 });
    expect(snapshotBody.value.escalated).toBeUndefined();

    // 5. time-to-first-renewal — positive: broker A's own controlled 7-day
    // offset; negative: not broker B's controlled 99-day offset.
    const timeToFirstRenewalBody = (await timeToFirstRenewalRes.json()) as { value: { days: number } | null };
    expect(timeToFirstRenewalBody.value).toEqual({ days: 7 });
    expect(timeToFirstRenewalBody.value?.days).not.toBe(99);

    // 6. cost — no live Langfuse client is wired in this phase (design.md
    // D-F, `apps/api/src/index.ts`'s `langfuseCostSource: null`), so there
    // is no broker-scoped data this query could leak in the first place;
    // included in the sweep for the endpoint-count requirement, asserting
    // only the disclosed-deferred shape the spec requires either broker
    // would see identically.
    const costBody = (await costRes.json()) as { value: null; status: string };
    expect(costBody).toEqual({ value: null, sampleSize: 0, empty: true, status: "deferred" });
  });

  it("task 8.4: the full login journey end-to-end — a seeded broker_users row with an email requests a link, the real test-double email client captures the dispatched URL, the callback consumes it, and the resulting session cookie authenticates a real GET /auth/me", async () => {
    const { app, cookieHeader } = await loginBrokerA();

    const meRes = await app.request("/auth/me", { headers: { Cookie: cookieHeader } });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { brokerId: string; brokerUserId: string; role: string };
    expect(meBody.brokerId).toBe(brokerAId);
    expect(meBody.role).toBe("agent");
  });
});
