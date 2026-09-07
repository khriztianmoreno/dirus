import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatwootMessageCreatedPayload } from "@dirus/schemas";

/**
 * Task 5.10/5.11/5.13 (design D-2, D-3, D-5): `services/ingest-message.ts`
 * is exactly the boundary D-5 draws ("no HTTP types cross this line") and
 * the one place Phase 1-2's proven primitives (`withBrokerContext`) get
 * exercised together with a real transaction. This needs a real Postgres
 * connection, so it is written as `describe.skipIf(!LIVE_TEST_DATABASE_URL)`
 * alongside the live suite, not as an offline unit test (which is what the
 * offline route/app tests use a FAKE ingest for instead).
 *
 * Mirrors `packages/db/test/migrations/live-rls-verification.test.ts`'s
 * throwaway-schema convention exactly (own uniquely-named schema inside
 * `LIVE_TEST_DATABASE_URL`, disposable owner/app fixture roles, `public` is
 * never touched, full teardown in `afterAll`) — see that file and
 * `packages/db/test/migrations/throwaway-schema.ts` /
 * `assert-throwaway-database.ts` for the established pattern this file
 * follows rather than inventing a second convention. Those two helper
 * modules are `packages/db`-internal test utilities (not exported from the
 * package), so this file re-implements the same shape locally rather than
 * importing across the package boundary.
 *
 * This suite is SEQUENTIAL only (one request awaited, then the next) — the
 * concurrent-delivery and concurrent-first-contact tests are explicitly
 * Phase 6's job (tasks.md, "These tests must dispatch requests
 * concurrently, not sequentially"), not this file's.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable (no
 * Docker/Podman, no `.env` access). `LIVE_TEST_DATABASE_URL` is unset here,
 * so this entire suite is reported as SKIPPED, not run — it must execute in
 * CI (see `.github/workflows/ci.yml`, which already wires
 * `LIVE_TEST_DATABASE_URL` to the `pgvector/pgvector:pg17` service
 * container for `packages/db`'s own live suites).
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../packages/db/migrations/${file}`, import.meta.url)),
    "utf8",
  );
}

function randomThrowawaySchemaName(): string {
  return `ingest_probe_${randomBytes(6).toString("hex")}`;
}

/** Same rewrite `packages/db/test/migrations/throwaway-schema.ts` performs, duplicated locally (see file header). */
function rewriteSchemaQualification(sql: string, schema: string): string {
  return sql.replaceAll('"public".', `"${schema}".`);
}

function rewriteUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

const OWNER_ROLE = "ingest_owner";
const APP_ROLE = "ingest_app";
const OWNER_PASSWORD = "ingest-owner-pass";
const APP_PASSWORD = "ingest-app-pass";

function buildPayload(overrides: Partial<ChatwootMessageCreatedPayload> = {}): ChatwootMessageCreatedPayload {
  return {
    event: "message_created",
    id: 1,
    content: "Hola, necesito una cotización",
    message_type: "incoming",
    content_type: "text",
    source_id: `wamid.${randomBytes(8).toString("hex")}`,
    sender: { id: 1, name: "Test Sender", phone_number: "+573000000001" },
    conversation: { id: 1 },
    account: { id: 1, name: "Test Account" },
    inbox: { id: 1, name: "Test Inbox" },
    ...overrides,
  };
}

describe.skipIf(!liveUrl)("ingestMessage (design D-2/D-3/D-5, live, sequential)", () => {
  let admin: Client;
  let schema: string;
  let brokerId: string;
  let safeToMutate = false;

  let closePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    const { assertThrowawayDatabase } = await importAssertThrowawayDatabase();
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
      await owner.query(rewriteSchemaQualification(readMigration("0000_init.sql"), schema));
      await owner.query(rewriteSchemaQualification(readMigration("0002_rls_policies.sql"), schema));
    } finally {
      await owner.end();
    }

    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}`);

    // Seeded directly as `admin` (superuser bypasses RLS outright), not as
    // OWNER_ROLE: 0002_rls_policies.sql applies FORCE ROW LEVEL SECURITY to
    // brokers, which binds the table-owning role too (Phase 1's live gate
    // proves this with a negative control). OWNER_ROLE has no
    // app.broker_id set at seed time — the id doesn't exist yet, it's what
    // this insert generates — so a FORCE-bound owner's insert would fail
    // exactly the way `assertThrowawayDatabase`-style seeding already
    // avoids in `live-tenant-resolution.test.ts` (see its "Seeded directly
    // as admin" comment). `admin`'s own session already has search_path
    // pointed at this throwaway schema (line 115 above).
    const result = await admin.query<{ id: string }>(
      "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ('Broker Ingest', 'phoneIngest', 'wabaIngest') RETURNING id",
    );
    brokerId = result.rows[0].id;
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

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (closePool) {
      await closePool();
      closePool = undefined;
    }
  });

  async function importAssertThrowawayDatabase() {
    // Deliberately re-implemented rather than imported across the package
    // boundary — see file header.
    return {
      assertThrowawayDatabase: async (client: Client) => {
        if (process.env.ALLOW_DESTRUCTIVE_LIVE_TESTS === "1") return;
        const result = await client.query<{ current_database: string }>("SELECT current_database()");
        const dbName = result.rows[0]?.current_database ?? "";
        if (!/(_test|_ci)$/i.test(dbName)) {
          throw new Error(
            `refusing to run destructive live tests against database "${dbName}": its name does ` +
              `not end in "_test" or "_ci". Set ALLOW_DESTRUCTIVE_LIVE_TESTS=1 to override.`,
          );
        }
      },
    };
  }

  it("first message from a new sender creates exactly one contacts row and one conversations row, and the message references both (spec: Contact/Conversation Find-or-Create)", async () => {
    process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
    process.env.ALLOW_UNPOOLED_RUNTIME = "1";
    const { ingestMessage } = await import("../../src/services/ingest-message.js");
    // `@dirus/db`'s barrel never exports the raw pool (design D-C), so
    // nothing in this file can close it directly; the test process exit
    // reclaims the connection, mirroring `tenant.test.ts`'s own convention
    // of not attempting to close a pool it has no handle to.

    const payload = buildPayload();
    const result = await ingestMessage(brokerId, payload);

    expect(result).toEqual({ deduplicated: false });

    const admin2 = new Client({ connectionString: liveUrl });
    await admin2.connect();
    try {
      await admin2.query(`SET search_path TO "${schema}"`);
      const contacts = await admin2.query("SELECT * FROM contacts WHERE broker_id = $1", [brokerId]);
      expect(contacts.rows).toHaveLength(1);
      const conversations = await admin2.query("SELECT * FROM conversations WHERE broker_id = $1", [brokerId]);
      expect(conversations.rows).toHaveLength(1);
      const messages = await admin2.query("SELECT * FROM messages WHERE broker_id = $1", [brokerId]);
      expect(messages.rows).toHaveLength(1);
      expect(messages.rows[0].conversation_id).toBe(conversations.rows[0].id);
      expect(contacts.rows[0].id).toBe(conversations.rows[0].contact_id);
    } finally {
      await admin2.end();
    }
  });

  it("a second message from the same sender reuses the existing contact and conversation (no duplicates)", async () => {
    process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
    process.env.ALLOW_UNPOOLED_RUNTIME = "1";
    const { ingestMessage } = await import("../../src/services/ingest-message.js");

    // A phone number distinct from the previous test's default
    // ("+573000000001"): `brokerId` (and this suite's throwaway schema) is
    // shared across every `it()` in this file via `beforeAll`, so reusing
    // the previous test's phone number would silently pick up its
    // already-committed contact/conversation/message and make this test's
    // outcome depend on execution order. A distinct phone number keeps this
    // test's own find-or-create claim self-contained regardless of what ran
    // before it.
    const senderPhone = "+573000000002";
    const first = await ingestMessage(brokerId, buildPayload({ id: 101, sender: { id: 2, name: "Test Sender 2", phone_number: senderPhone } }));
    const second = await ingestMessage(brokerId, buildPayload({ id: 102, sender: { id: 2, name: "Test Sender 2", phone_number: senderPhone } }));

    expect(first).toEqual({ deduplicated: false });
    expect(second).toEqual({ deduplicated: false });

    const admin2 = new Client({ connectionString: liveUrl });
    await admin2.connect();
    try {
      await admin2.query(`SET search_path TO "${schema}"`);
      const contacts = await admin2.query(
        "SELECT * FROM contacts WHERE broker_id = $1 AND phone = $2",
        [brokerId, senderPhone],
      );
      expect(contacts.rows).toHaveLength(1);
      const conversations = await admin2.query(
        "SELECT * FROM conversations WHERE broker_id = $1 AND contact_id = $2",
        [brokerId, contacts.rows[0].id],
      );
      expect(conversations.rows).toHaveLength(1);
      // Scoped to THIS test's conversation, not `WHERE broker_id = $1` —
      // the latter would also count messages other `it()` blocks in this
      // shared-fixture suite have already committed for this broker.
      const messages = await admin2.query("SELECT * FROM messages WHERE conversation_id = $1", [
        conversations.rows[0].id,
      ]);
      expect(messages.rows).toHaveLength(2);
    } finally {
      await admin2.end();
    }
  });

  it("a duplicate wa_message_id on a sequential replay: transaction still commits, no second messages row, {deduplicated:true}", async () => {
    process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
    process.env.ALLOW_UNPOOLED_RUNTIME = "1";
    const { ingestMessage } = await import("../../src/services/ingest-message.js");

    const sharedWamid = `wamid.dup-${randomBytes(6).toString("hex")}`;
    const payload = buildPayload({ id: 201, source_id: sharedWamid });

    const first = await ingestMessage(brokerId, payload);
    const second = await ingestMessage(brokerId, buildPayload({ id: 202, source_id: sharedWamid }));

    expect(first).toEqual({ deduplicated: false });
    expect(second).toEqual({ deduplicated: true });

    const admin2 = new Client({ connectionString: liveUrl });
    await admin2.connect();
    try {
      await admin2.query(`SET search_path TO "${schema}"`);
      const messages = await admin2.query("SELECT * FROM messages WHERE wa_message_id = $1", [sharedWamid]);
      expect(messages.rows).toHaveLength(1);
    } finally {
      await admin2.end();
    }
  });

  it("a media message persists with media_r2_key NULL and made no network call (spec P3)", async () => {
    process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
    process.env.ALLOW_UNPOOLED_RUNTIME = "1";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { ingestMessage } = await import("../../src/services/ingest-message.js");

    const payload = buildPayload({ id: 301, content_type: "image", content: null, source_id: null });
    const result = await ingestMessage(brokerId, payload);

    expect(result).toEqual({ deduplicated: false });
    expect(fetchSpy).not.toHaveBeenCalled();

    const admin2 = new Client({ connectionString: liveUrl });
    await admin2.connect();
    try {
      await admin2.query(`SET search_path TO "${schema}"`);
      const messages = await admin2.query(
        "SELECT * FROM messages WHERE broker_id = $1 AND type = 'image' ORDER BY created_at DESC LIMIT 1",
        [brokerId],
      );
      expect(messages.rows[0].media_r2_key).toBeNull();
    } finally {
      await admin2.end();
      vi.unstubAllGlobals();
    }
  });
});
