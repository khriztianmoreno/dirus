import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertThrowawayDatabase } from "./assert-throwaway-database.js";
import {
  createThrowawaySchema,
  dropThrowawaySchema,
  randomThrowawaySchemaName,
  rewriteSchemaQualification,
} from "./throwaway-schema.js";

/**
 * data-model delta spec (`policy-bulk-import`, "Partial Unique Index on
 * Numbered Policies"): `policy-number-unique-index.test.ts` proves the
 * committed migration SQL *declares* the right index shape, but only a real
 * Postgres can prove it actually *enforces* the right behavior — in
 * particular that it is a *partial* index and not a plain unique index that
 * happens to pass by accident (proposal P5: Postgres already treats NULLs
 * as distinct in a plain unique index too, so a NULL-vs-NULL insert test
 * alone would pass against either shape — see this file's third `it()` and
 * apply-progress.md's discussion of why that specific assertion carries no
 * discriminating signal here).
 *
 * Follows `live-rls-verification.test.ts`'s established conventions
 * exactly: `describe.skipIf(!LIVE_TEST_DATABASE_URL)`, a per-run throwaway
 * schema (never `public`), `assertThrowawayDatabase` before any destructive
 * statement, and a `safeToMutate` gate so a refused `beforeAll` can never
 * let `afterAll` run a destructive statement.
 *
 * Deliberate, disclosed deviation from that file's shape: this suite never
 * applies `0002_rls_policies.sql` and creates no `OWNER_ROLE`/`APP_ROLE`
 * split. The behavior under test here is the unique index alone, not RLS,
 * and `policies` carries `FORCE ROW LEVEL SECURITY` only once 0002 is
 * applied — applying it here would require either seeding through a
 * superuser/admin connection (bypassing RLS outright) or a role with
 * `app.broker_id` already set, exactly the trap
 * `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/apply-progress.md`'s
 * Phase 5 section documents CI's first round-trip catching (`OWNER_ROLE`
 * seeded before `app.broker_id` exists, and FORCE bound the owner too).
 * Since this suite has no RLS assertion to make, the correct fix is not to
 * reproduce that split at all: every statement below runs on the single
 * `admin` connection, inside the throwaway schema, where no RLS policy is
 * ever installed.
 *
 * The second lesson from that same section — cross-test/cross-fixture
 * leakage from broker-wide assertions — is avoided the same way: every
 * `it()` below creates its own broker, its own contact(s), and asserts only
 * against rows scoped by `broker_id`/`policy_number` values unique to that
 * test, never a bare count across the whole suite.
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}

async function insertBroker(client: Client, id: string, name: string, waPhone: string, waba: string): Promise<void> {
  await client.query("INSERT INTO brokers (id, name, wa_phone_number_id, waba_id) VALUES ($1, $2, $3, $4)", [
    id,
    name,
    waPhone,
    waba,
  ]);
}

async function insertContact(client: Client, id: string, brokerId: string, phone: string): Promise<void> {
  await client.query("INSERT INTO contacts (id, broker_id, phone) VALUES ($1, $2, $3)", [id, brokerId, phone]);
}

async function insertPolicy(
  client: Client,
  id: string,
  brokerId: string,
  contactId: string,
  policyNumber: string | null,
): Promise<void> {
  await client.query(
    "INSERT INTO policies (id, broker_id, contact_id, insurer, line, end_date, policy_number) " +
      "VALUES ($1, $2, $3, 'Sura', 'auto', '2027-01-01', $4)",
    [id, brokerId, contactId, policyNumber],
  );
}

describe.skipIf(!liveUrl)("live policy_number unique index (real Postgres)", () => {
  let admin: Client;
  let schema: string;
  // Same gate as live-rls-verification.test.ts: only becomes true once the
  // throwaway-database check and schema creation have both succeeded, so a
  // refused beforeAll can never let afterAll run a destructive statement.
  let safeToMutate = false;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    await assertThrowawayDatabase(admin);

    schema = randomThrowawaySchemaName();
    await createThrowawaySchema(admin, schema);
    safeToMutate = true;

    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(rewriteSchemaQualification(readMigration("0000_init.sql"), schema));
    await admin.query(rewriteSchemaQualification(readMigration("0005_policy_number_unique_index.sql"), schema));
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      if (safeToMutate) {
        await dropThrowawaySchema(admin, schema);
      }
    } finally {
      await admin.end();
    }
  });

  it("rejects a second policy with the same (broker_id, policy_number)", async () => {
    const brokerId = randomUUID();
    const contactId = randomUUID();
    const policyNumber = "POL-COLLISION-1";
    await insertBroker(admin, brokerId, "Broker Collision", "phone-collision", "waba-collision");
    await insertContact(admin, contactId, brokerId, "3000001001");
    await insertPolicy(admin, randomUUID(), brokerId, contactId, policyNumber);

    await expect(insertPolicy(admin, randomUUID(), brokerId, contactId, policyNumber)).rejects.toThrow(
      /duplicate key value violates unique constraint/i,
    );

    const rows = await admin.query("SELECT count(*) FROM policies WHERE broker_id = $1 AND policy_number = $2", [
      brokerId,
      policyNumber,
    ]);
    expect(rows.rows[0].count).toBe("1");
  });

  it("permits two sequential inserts with a NULL policy_number for the same broker", async () => {
    // The non-collision proof, the whole point of the partial index.
    //
    // Read carefully before trusting this assertion alone: a PLAIN
    // `UNIQUE (broker_id, policy_number)` (no WHERE clause) ALSO permits
    // this — Postgres already treats every NULL as distinct from every
    // other NULL in a standard unique index, partial or not. This test
    // therefore does NOT, by itself, discriminate "partial index" from
    // "plain unique index"; it only discriminates the partial index from
    // `NULLS NOT DISTINCT` (which would collapse these two rows into a
    // unique-violation). See apply-progress.md for the mutation-testing
    // analysis of whether that gap matters here, and
    // `policy-number-unique-index.test.ts` for the structural assertion
    // that actually pins the migration to a `WHERE policy_number IS NOT
    // NULL` shape rather than a plain unique index.
    const brokerId = randomUUID();
    const contactId = randomUUID();
    await insertBroker(admin, brokerId, "Broker Null", "phone-null", "waba-null");
    await insertContact(admin, contactId, brokerId, "3000001002");

    await insertPolicy(admin, randomUUID(), brokerId, contactId, null);
    await insertPolicy(admin, randomUUID(), brokerId, contactId, null);

    const rows = await admin.query(
      "SELECT count(*) FROM policies WHERE broker_id = $1 AND policy_number IS NULL",
      [brokerId],
    );
    expect(rows.rows[0].count).toBe("2");
  });

  it("permits the same policy_number across different brokers", async () => {
    const brokerA = randomUUID();
    const brokerB = randomUUID();
    const contactA = randomUUID();
    const contactB = randomUUID();
    const policyNumber = "POL-SHARED-9";
    await insertBroker(admin, brokerA, "Broker Cross A", "phone-cross-a", "waba-cross-a");
    await insertBroker(admin, brokerB, "Broker Cross B", "phone-cross-b", "waba-cross-b");
    await insertContact(admin, contactA, brokerA, "3000001003");
    await insertContact(admin, contactB, brokerB, "3000001004");

    await insertPolicy(admin, randomUUID(), brokerA, contactA, policyNumber);
    await insertPolicy(admin, randomUUID(), brokerB, contactB, policyNumber);

    const rows = await admin.query(
      "SELECT broker_id::text FROM policies WHERE policy_number = $1 ORDER BY broker_id",
      [policyNumber],
    );
    expect(rows.rows.map((r: { broker_id: string }) => r.broker_id).sort()).toEqual([brokerA, brokerB].sort());
  });
});
