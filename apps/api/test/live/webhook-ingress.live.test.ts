import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatwootMessageCreatedPayload } from "@dirus/schemas";

import { createApp } from "../../src/app.js";

/**
 * Phase 6 (tasks.md, "Live integration tests — concurrency and isolation
 * (non-negotiable)") — tasks 6.1-6.7. This is the file that actually PROVES
 * the two claims the whole change rests on (proposal.md "Intent"):
 *
 *   1. Design D-2/D-3: two simultaneous deliveries never duplicate a
 *      `conversations` row for a brand-new sender, and two simultaneous
 *      deliveries of the same `wa_message_id` leave exactly one `messages`
 *      row. Tasks 6.1-6.4.
 *   2. The ROADMAP's non-negotiable hard requirement: broker X cannot read
 *      broker Y's `messages`/`conversations`/`contacts` rows, seeded through
 *      the REAL webhook ingress path, not raw SQL. Tasks 6.5-6.7.
 *
 * **Dispatch pattern is load-bearing.** Every concurrency assertion below
 * fires both requests via `Promise.all([post(...), post(...)])` — i.e. BOTH
 * `app.request(...)` calls are issued before either is awaited to
 * completion — never `await post(a); await post(b)`. A sequential await
 * would pass even against a broken check-then-insert implementation and
 * would prove nothing about the race design D-2/D-3 forbids (tasks.md's own
 * words, echoed in design.md's "DO UPDATE vs DO NOTHING" reasoning). If a
 * test below is ever rewritten to await sequentially, it silently stops
 * testing what its own `it()` title claims.
 *
 * **Why this file needs its OWN dedicated database**
 * (`WEBHOOK_INGRESS_TEST_DATABASE_URL`), not the shared `LIVE_TEST_DATABASE_URL`
 * throwaway-schema convention `ingest-message.live.test.ts` (Phase 5) uses:
 * unlike Phase 5's suite, this file dispatches through the REAL tenant
 * -resolver middleware, which calls `resolveBrokerIdByWaPhoneNumberId` ->
 * `dirus_resolve_broker_id` (migration `0004_tenant_resolver.sql`). That
 * function's `SECURITY DEFINER` body hardcodes `public.brokers`
 * (schema-qualified — the search_path-hijack defense itself, design.md D-1),
 * so it cannot run against a randomly-named throwaway schema the way
 * `0000`/`0002` can. This mirrors `packages/db/test/migrations/
 * live-tenant-resolution.test.ts`'s file header exactly, and this file's
 * `beforeAll`/`afterAll` shape mirrors that file's (own database, migrations
 * applied to the real `public` schema, full teardown) rather than
 * `live-rls-verification.test.ts`/`ingest-message.live.test.ts`'s
 * throwaway-schema shape — do not "fix" this to match the other convention.
 *
 * Two-broker fixture conventions mirrored from
 * `packages/db/test/migrations/live-rls-verification.test.ts` (disposable
 * fixture roles, `assertThrowawayDatabase`, full teardown) and
 * `rls-catalog-guard.test.ts` — extended here to seed `messages`/
 * `conversations`/`contacts` via the real webhook path (task 6.5) rather
 * than direct SQL inserts, per proposal.md's stated testing convention
 * ("do not invent a second convention").
 *
 * **Lessons carried over from Phase 5's two CI round-trips** (see
 * apply-progress.md, Phase 5 section) — both mistakes are easy to repeat
 * here and this file deliberately avoids them:
 *
 *   1. `brokers` carries `FORCE ROW LEVEL SECURITY`, which binds the
 *      table-owning role too. Every seed insert into `brokers` below runs as
 *      `admin` (superuser, bypasses RLS outright), never as `OWNER_ROLE` —
 *      `OWNER_ROLE` has no `app.broker_id` set at seed time (the id doesn't
 *      exist yet), so a FORCE-bound owner's insert would fail exactly the
 *      way Phase 1's negative control fails on purpose.
 *   2. This suite shares one throwaway database and two broker fixtures
 *      across every `it()` (deliberately, since find-or-create reuse and
 *      cross-tenant isolation are both about state that persists across
 *      calls). Every assertion below is scoped to what THAT test itself
 *      created (a dedicated phone number per test, `WHERE conversation_id =
 *      $1` rather than a broker-wide count) — never a broker-wide
 *      `WHERE broker_id = $1` count, which would silently include rows
 *      other tests (or `beforeAll`'s own isolation-fixture seed) already
 *      committed.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable (no
 * Docker/Podman, no `.env` access). `WEBHOOK_INGRESS_TEST_DATABASE_URL` is
 * unset here, so this entire suite is reported as SKIPPED, not run — it
 * must execute in CI (`.github/workflows/ci.yml` creates
 * `dirus_webhook_ingress_test` and wires this env var to it).
 *
 * **Mutation-testing note (tasks 6.1/6.3):** this environment cannot execute
 * this file at all (no Postgres reachable), so neither a literal RED nor a
 * confirming mutation run was possible here. Per tasks.md's own instruction
 * ("observed passing immediately if 5.12 already landed correctly ... in
 * the latter case, confirm by mutation"), whoever runs this suite in CI and
 * finds 6.1/6.2/6.3/6.4 green on first execution MUST additionally: (a) for
 * 6.1, temporarily replace the messages insert's `.onConflictDoNothing(...)`
 * in `src/services/ingest-message.ts` with a read-then-insert, confirm this
 * file's dedup test then fails, then restore; (b) for 6.3, temporarily swap
 * the contacts upsert's `.onConflictDoUpdate(...)` for `.onConflictDoNothing(...)`
 * in the same file, confirm this file's new-contact test then fails (two
 * `conversations` rows), then restore. This is disclosed here rather than
 * silently skipped — see apply-progress.md's Phase 6 section.
 */
const liveUrl = process.env.WEBHOOK_INGRESS_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../packages/db/migrations/${file}`, import.meta.url)),
    "utf8",
  );
}

function rewriteUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

/** Deliberately re-implemented rather than imported across the package boundary — see file header. */
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

const OWNER_ROLE = "webhook_ingress_owner";
const OWNER_PASSWORD = "webhook-ingress-owner-pass";
const APP_PASSWORD = "webhook-ingress-app-pass";
const WEBHOOK_TOKEN = "w".repeat(32);

function buildPayload(overrides: Partial<ChatwootMessageCreatedPayload> & { inboxPhone: string }): ChatwootMessageCreatedPayload {
  const { inboxPhone, ...rest } = overrides;
  return {
    event: "message_created",
    id: 1,
    content: "Hola, necesito una cotización",
    message_type: "incoming",
    content_type: "text",
    source_id: `wamid.${randomBytes(8).toString("hex")}`,
    sender: { id: 1, name: "Test Sender", phone_number: "+573000000001" },
    contact: { id: 1, name: "Test Sender", phone_number: "+573000000001" },
    conversation: { id: 1 },
    account: { id: 1, name: "Test Account" },
    inbox: { id: 1, name: "Test Inbox", phone_number: inboxPhone },
    ...rest,
  };
}

async function post(app: ReturnType<typeof createApp>, payload: ChatwootMessageCreatedPayload) {
  return app.request("/webhooks/chatwoot", {
    method: "POST",
    headers: { "X-Dirus-Webhook-Token": WEBHOOK_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Builds a `createApp(...)` wired to the REAL `resolveBrokerIdByWaPhoneNumberId`
 * (`@dirus/db`) and the REAL `ingestMessage` (`services/ingest-message.ts`),
 * with a fake `sendEcho` — this file never needs to reach an actual Chatwoot
 * API, and `packages/integrations/src/chatwoot.ts` already has its own test
 * suite (Phase 5). `vi.resetModules()` first, per `ingest-message.live.test.ts`'s
 * established convention: `@dirus/db` reads `DATABASE_URL` at import time,
 * so each call here gets a fresh module graph bound to whatever
 * `DATABASE_URL` is set to at call time.
 */
async function buildLiveApp(sendEcho = vi.fn(async () => undefined)) {
  vi.resetModules();
  process.env.DATABASE_URL = rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD);
  process.env.ALLOW_UNPOOLED_RUNTIME = "1";
  const { resolveBrokerIdByWaPhoneNumberId } = await import("@dirus/db");
  const { ingestMessage } = await import("../../src/services/ingest-message.js");
  const app = createApp({
    ingest: ingestMessage,
    resolveBrokerId: resolveBrokerIdByWaPhoneNumberId,
    webhookToken: WEBHOOK_TOKEN,
    sendEcho,
    adminToken: "a".repeat(32),
    resolveBrokerExists: async () => true,
    importPolicyRows: async (brokerId: string) => ({
      brokerId,
      totals: { rows: 0, inserted: 0, updated: 0, failed: 0 },
      rows: [],
    }),
    resolveBrokerIdByEmail: async () => null,
    issueMagicLinkToken: async () => undefined,
    sendMagicLink: async () => undefined,
    dashboardBaseUrl: "https://app.dirus.io",
    resolveBrokerIdByMagicLinkTokenHash: async () => null,
    consumeMagicLinkToken: async () => ({ ok: false as const }),
    createSession: async () => ({ rawSessionToken: "s".repeat(43), rawCsrfToken: "c".repeat(43) }),
    resolveSession: async () => null,
    revokeSession: async () => undefined,
  });
  return { app, sendEcho };
}

describe.skipIf(!liveUrl)("webhook ingress — live concurrency and cross-tenant isolation (tasks 6.1-6.7)", () => {
  let admin: Client;
  let brokerXId: string;
  let brokerYId: string;
  let safeToMutate = false;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    await assertThrowawayDatabase(admin);

    // Idempotent local re-run cleanup, mirroring live-tenant-resolution.test.ts.
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query("DROP ROLE IF EXISTS dirus_app");
    await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
    await admin.query("DROP ROLE IF EXISTS dirus_tenant_resolver");

    safeToMutate = true;

    await admin.query(`CREATE ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE ROLE dirus_app WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER_ROLE}`);

    const owner = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, OWNER_PASSWORD) });
    await owner.connect();
    try {
      await owner.query(readMigration("0000_init.sql"));
      await owner.query(readMigration("0002_rls_policies.sql"));
    } finally {
      await owner.end();
    }

    // 0004 as admin (superuser): CREATE POLICY needs table ownership or
    // superuser, and the role/membership DDL needs CREATEROLE. dirus_app
    // already exists (created above), so 0004's own `IF EXISTS` guard runs
    // against the real production DO block, not a hand-rolled stand-in.
    await admin.query(readMigration("0004_tenant_resolver.sql"));

    // See file header: this hand-created public schema carries no PUBLIC
    // USAGE grant (unlike a fresh database's initdb-provided one), so this
    // is not optional.
    await admin.query(`GRANT USAGE ON SCHEMA public TO dirus_app`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dirus_app`);

    // Brokers themselves are provisioned out-of-band (broker onboarding),
    // never through the webhook ingress path — task 6.5 scopes "seed via
    // the ingress path" to messages/conversations/contacts only. Seeded
    // directly as `admin` (superuser bypasses RLS outright), never as
    // OWNER_ROLE: see file header, lesson 1.
    const seedX = await admin.query<{ id: string }>(
      "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ('Broker X', 'phoneX', 'wabaX') RETURNING id",
    );
    brokerXId = seedX.rows[0].id;
    const seedY = await admin.query<{ id: string }>(
      "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ('Broker Y', 'phoneY', 'wabaY') RETURNING id",
    );
    brokerYId = seedY.rows[0].id;

    // Task 6.5: seed contacts/conversations/messages for BOTH brokers via
    // the actual webhook ingress path (auth -> parse -> resolveBrokerId ->
    // ingest), not direct SQL inserts.
    const { app: seedApp } = await buildLiveApp();
    const seedResX = await post(
      seedApp,
      buildPayload({
        id: 9001,
        source_id: "wamid.iso-seed-x",
        inboxPhone: "phoneX",
        sender: { id: 9001, name: "Iso Sender X", phone_number: "+573000009001" },
        contact: { id: 9001, name: "Iso Sender X", phone_number: "+573000009001" },
      }),
    );
    if (seedResX.status >= 300) {
      throw new Error(`task 6.5 seed for broker X failed with status ${seedResX.status}`);
    }
    const seedResY = await post(
      seedApp,
      buildPayload({
        id: 9002,
        source_id: "wamid.iso-seed-y",
        inboxPhone: "phoneY",
        sender: { id: 9002, name: "Iso Sender Y", phone_number: "+573000009002" },
        contact: { id: 9002, name: "Iso Sender Y", phone_number: "+573000009002" },
      }),
    );
    if (seedResY.status >= 300) {
      throw new Error(`task 6.5 seed for broker Y failed with status ${seedResY.status}`);
    }
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      if (safeToMutate) {
        await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
        await admin.query("CREATE SCHEMA public");
        await admin.query("DROP ROLE IF EXISTS dirus_app");
        await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
        await admin.query("DROP ROLE IF EXISTS dirus_tenant_resolver");
      }
    } finally {
      await admin.end();
    }
  });

  beforeEach(() => {
    // Each it() below calls buildLiveApp(), which resets modules itself —
    // this extra reset only covers tests that do not (there are none
    // currently, kept for symmetry with ingest-message.live.test.ts's
    // established convention).
    vi.resetModules();
  });

  it("6.1/6.2: concurrent delivery of the same wa_message_id leaves exactly one messages row and both requests return 2xx (design D-3, spec 'Concurrent delivery of the same wa_message_id leaves one row')", async () => {
    const { app } = await buildLiveApp();
    const sharedWamid = `wamid.concurrent-dup-${randomBytes(6).toString("hex")}`;
    const senderPhone = "+573000009101";

    const payloadA = buildPayload({
      id: 9101,
      source_id: sharedWamid,
      inboxPhone: "phoneX",
      sender: { id: 9101, name: "Dup Sender", phone_number: senderPhone },
      contact: { id: 9101, name: "Dup Sender", phone_number: senderPhone },
    });
    const payloadB = buildPayload({
      id: 9102,
      source_id: sharedWamid,
      inboxPhone: "phoneX",
      sender: { id: 9101, name: "Dup Sender", phone_number: senderPhone },
      contact: { id: 9101, name: "Dup Sender", phone_number: senderPhone },
    });

    // BOTH requests fired before either is awaited to completion — see file
    // header, "Dispatch pattern is load-bearing".
    const [resA, resB] = await Promise.all([post(app, payloadA), post(app, payloadB)]);

    expect(resA.status).toBeLessThan(300);
    expect(resB.status).toBeLessThan(300);

    const messages = await admin.query("SELECT * FROM messages WHERE wa_message_id = $1", [sharedWamid]);
    expect(messages.rows).toHaveLength(1);
  });

  it("6.3/6.4: concurrent first messages from the same new contact do not duplicate the conversation, and both messages reference the single conversation (design D-2, spec 'Concurrent first messages from the same new contact do not duplicate the conversation')", async () => {
    const { app } = await buildLiveApp();
    const senderPhone = "+573000009201";

    const payloadA = buildPayload({
      id: 9201,
      source_id: `wamid.concurrent-new-a-${randomBytes(6).toString("hex")}`,
      inboxPhone: "phoneX",
      sender: { id: 9201, name: "New Sender", phone_number: senderPhone },
      contact: { id: 9201, name: "New Sender", phone_number: senderPhone },
    });
    const payloadB = buildPayload({
      id: 9202,
      source_id: `wamid.concurrent-new-b-${randomBytes(6).toString("hex")}`,
      inboxPhone: "phoneX",
      sender: { id: 9201, name: "New Sender", phone_number: senderPhone },
      contact: { id: 9201, name: "New Sender", phone_number: senderPhone },
    });

    // BOTH requests fired before either is awaited to completion — see file
    // header, "Dispatch pattern is load-bearing".
    const [resA, resB] = await Promise.all([post(app, payloadA), post(app, payloadB)]);

    expect(resA.status).toBeLessThan(300);
    expect(resB.status).toBeLessThan(300);

    const contacts = await admin.query("SELECT id FROM contacts WHERE broker_id = $1 AND phone = $2", [
      brokerXId,
      senderPhone,
    ]);
    expect(contacts.rows).toHaveLength(1);

    const conversations = await admin.query(
      "SELECT id FROM conversations WHERE broker_id = $1 AND contact_id = $2",
      [brokerXId, contacts.rows[0].id],
    );
    expect(conversations.rows).toHaveLength(1);

    // Scoped to THIS test's own conversation, not a broker-wide count — see
    // file header, lesson 2.
    const messages = await admin.query("SELECT id FROM messages WHERE conversation_id = $1", [
      conversations.rows[0].id,
    ]);
    expect(messages.rows).toHaveLength(2);
  });

  it("6.6: broker X's tenant-scoped session reads none of broker Y's messages, conversations, or contacts rows (non-negotiable — spec 'Broker X cannot read Broker Y's messages, conversations, or contacts rows')", async () => {
    const appConn = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await appConn.connect();
    try {
      await appConn.query("BEGIN");
      await appConn.query("SELECT set_config('app.broker_id', $1, true)", [brokerXId]);

      const contacts = await appConn.query<{ id: string; broker_id: string }>(
        "SELECT id, broker_id FROM contacts",
      );
      const conversations = await appConn.query<{ id: string; broker_id: string }>(
        "SELECT id, broker_id FROM conversations",
      );
      const messages = await appConn.query<{ id: string; broker_id: string }>(
        "SELECT id, broker_id FROM messages",
      );
      await appConn.query("COMMIT");

      // Rows seeded for broker Y in task 6.5's beforeAll fixture must be
      // absent from every one of these result sets.
      for (const row of [...contacts.rows, ...conversations.rows, ...messages.rows]) {
        expect(row.broker_id).toBe(brokerXId);
        expect(row.broker_id).not.toBe(brokerYId);
      }
      // Sanity: broker X's own rows from 6.5's seed ARE visible — an empty
      // result set would make the assertion above vacuously true.
      expect(contacts.rows.length).toBeGreaterThan(0);
    } finally {
      await appConn.end();
    }
  });

  it("6.7: dirus_app's session still returns zero rows on a direct SELECT * FROM brokers immediately after a webhook request resolves a tenant through the real pipeline (closes the loop from task 1.6 assertion 2, spec 'The tenant-resolution mechanism does not expose arbitrary brokers rows')", async () => {
    // Trigger tenant resolution through the REAL webhook pipeline — auth,
    // stage-1/2 parse, extractResolutionKey, then the REAL
    // resolveBrokerIdByWaPhoneNumberId — not a raw `SELECT
    // dirus_resolve_broker_id(...)` call the way task 1.6 proved this in
    // isolation.
    const { app } = await buildLiveApp();
    const senderPhone = "+573000009301";
    const res = await post(
      app,
      buildPayload({
        id: 9301,
        source_id: `wamid.close-loop-${randomBytes(6).toString("hex")}`,
        inboxPhone: "phoneX",
        sender: { id: 9301, name: "Close Loop Sender", phone_number: senderPhone },
        contact: { id: 9301, name: "Close Loop Sender", phone_number: senderPhone },
      }),
    );
    expect(res.status).toBeLessThan(300);

    // `@dirus/db`'s barrel deliberately exposes no raw-query handle (design
    // D-C) — the app itself has no way to issue a "direct SELECT * FROM
    // brokers", by construction. Closing the loop therefore means: a fresh
    // connection authenticated as the SAME role (`dirus_app`) the pipeline
    // above just ran as, checked immediately afterward, still carries no
    // standing privilege to read `brokers` directly. This is not a literal
    // same-physical-connection proof the way task 1.6's raw pg.Client
    // negative control is (that remains the authoritative same-session
    // proof); it is the closest equivalent achievable through the real
    // pipeline's own exported surface, and is disclosed as such rather than
    // overclaimed.
    const direct = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await direct.connect();
    try {
      const count = await direct.query("SELECT count(*) FROM brokers");
      expect(count.rows[0].count).toBe("0");
      const star = await direct.query("SELECT * FROM brokers");
      expect(star.rows).toHaveLength(0);
    } finally {
      await direct.end();
    }
  });
});
