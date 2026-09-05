import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 5 tasks 5.4, 5.6-5.9, 5.11, 5.13-5.15, 5.17, 5.19-5.20, 5.22 — the
 * live half of `import-policies-writer.ts`'s per-row loop: contact
 * find-or-create, the consent invariant, the idempotent policy upsert, the
 * policy_number/contact mismatch check, and the no-delete/reconcile
 * guarantee. All of these require a real transaction against real tables
 * (`withBrokerContext`'s `set_config`, real `ON CONFLICT` upserts, real
 * savepoints) — none of this is fakeable offline, unlike
 * `import-policies.test.ts` (Phase 4 guards) and
 * `import-policies-parse.test.ts` (Phase 5 parsing), both pure/offline.
 *
 * **Convention: mirrors `live-policy-number-unique-index.test.ts`
 * (Phase 1), NOT `ingest-message.live.test.ts` (F2 Phase 5)** — the task
 * brief for this phase calls this out explicitly. Every statement below
 * runs on a SINGLE role (see "Why one role, not an OWNER/APP split"), never
 * `0002_rls_policies.sql`'s FORCE-bound owner/app split: this phase's own
 * task list (5.1-5.24) has no RLS-crossing assertion to make — that is
 * Phase 7's job (spec "Import Runs Within withBrokerContext and Respects
 * RLS", tested by `apps/api/test/live/` Phase 7, not here). Task 5.24
 * itself is a code-inspection confirmation (see `import-policies-writer.ts`
 * docstrings on `importPolicyRows`/`processRow`), not a live test.
 *
 * **Why one role, not an OWNER/APP split**: this suite needs the SERVICE's
 * own `@dirus/db`-backed `importPolicyRows` (via `withBrokerContext`) to
 * write through a role that can actually log in and issue queries — a bare
 * "run everything as `admin`" (superuser) convention like
 * `live-policy-number-unique-index.test.ts` uses would work too, but a
 * dedicated throwaway role scoped to this suite's own schema (created and
 * dropped in this file's own `beforeAll`/`afterAll`, like
 * `ingest-message.live.test.ts`'s `APP_ROLE`) avoids ever pointing
 * `DATABASE_URL` at a shared superuser credential from a test file.
 * `0002_rls_policies.sql` (RLS/FORCE) is deliberately never applied here,
 * so this throwaway role needs no `NOBYPASSRLS` significance either way —
 * it exists purely so `importPolicyRows` has a real, disposable login to
 * connect as.
 *
 * **Two lessons carried over from `whatsapp-webhook-ingress`'s Phase 5
 * (see that change's archived `apply-progress.md`), both deliberately
 * avoided here**:
 *   1. `brokers` carries `FORCE ROW LEVEL SECURITY` once `0002` is applied
 *      — this suite never applies `0002` at all, so every seed/assertion
 *      below (including this dedicated app role's own writes) is
 *      unaffected by that trap by construction, not by seeding-as-admin
 *      discipline.
 *   2. Cross-test/cross-fixture leakage from broker-wide assertions: every
 *      `it()` below creates its OWN broker (and its own contacts/policies),
 *      and every assertion is scoped by that test's own `brokerId` /
 *      `policyNumber` / `phone` values — never a bare count across the
 *      whole suite.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable
 * (no Docker/Podman daemon, no `.env`). `LIVE_TEST_DATABASE_URL` is unset
 * here, so this entire suite reports SKIPPED, not run — it must execute in
 * CI. See this change's `apply-progress.md` Phase 5 section for the full
 * disclosure, including the consent test's (5.11/5.12) verification
 * convention, which could not be empirically confirmed in this environment
 * either.
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../packages/db/migrations/${file}`, import.meta.url)),
    "utf8",
  );
}

function randomThrowawaySchemaName(): string {
  return `policy_import_probe_${randomBytes(6).toString("hex")}`;
}

/** Same rewrite `packages/db/test/migrations/throwaway-schema.ts` performs, duplicated locally (see file header, F2 precedent). */
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

const APP_ROLE = "policy_import_app";
const APP_PASSWORD = "policy-import-app-pass";

async function insertBroker(client: Client, name: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ($1, $2, $3) RETURNING id",
    [name, `wa-${randomBytes(4).toString("hex")}`, `waba-${randomBytes(4).toString("hex")}`],
  );
  return result.rows[0].id;
}

async function insertContact(
  client: Client,
  brokerId: string,
  phone: string,
  overrides: { fullName?: string | null; docNumber?: string | null } = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO contacts (broker_id, phone, full_name, doc_number) VALUES ($1, $2, $3, $4) RETURNING id",
    [brokerId, phone, overrides.fullName ?? null, overrides.docNumber ?? null],
  );
  return result.rows[0].id;
}

async function insertPolicy(
  client: Client,
  brokerId: string,
  contactId: string,
  policyNumber: string | null,
  endDate = "2027-01-01",
): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO policies (broker_id, contact_id, insurer, line, end_date, policy_number) " +
      "VALUES ($1, $2, 'Sura', 'auto', $3, $4) RETURNING id",
    [brokerId, contactId, endDate, policyNumber],
  );
  return result.rows[0].id;
}

type Row = Record<string, string>;

function row(overrides: Partial<Row> & { insurer?: string; line?: string; endDate: string; phone: string }): Row {
  return {
    insurer: "Sura",
    line: "auto",
    ...overrides,
  };
}

describe.skipIf(!liveUrl)("importPolicyRows (Phase 5, live, per-row loop)", () => {
  let admin: Client;
  let schema: string;
  let safeToMutate = false;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    await assertThrowawayDatabase(admin);

    await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);

    schema = randomThrowawaySchemaName();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    safeToMutate = true;

    await admin.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${APP_ROLE}`);
    await admin.query(`ALTER ROLE ${APP_ROLE} SET search_path TO "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);

    // Migrations applied as `admin` (superuser) directly — no
    // OWNER_ROLE/APP_ROLE ownership split needed: see file header, "Why
    // one role, not an OWNER/APP split". 0002 (RLS) is deliberately never
    // applied — this phase's tests make no RLS assertion.
    await admin.query(rewriteSchemaQualification(readMigration("0000_init.sql"), schema));
    await admin.query(
      rewriteSchemaQualification(readMigration("0005_policy_number_unique_index.sql"), schema),
    );

    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}`);
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

  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
    process.env.ALLOW_UNPOOLED_RUNTIME = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadImportPolicyRows() {
    const { importPolicyRows } = await import("../../src/services/import-policies-writer.js");
    return importPolicyRows;
  }

  it("5.4/5.5: one malformed row (invalid end_date) among 5 does not fail the other 4", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.4");

    const rows: Row[] = [
      row({ endDate: "2027-01-01", phone: "+573000010001" }),
      row({ endDate: "2027-01-02", phone: "+573000010002" }),
      row({ endDate: "2027-01-03", phone: "+573000010003" }),
      row({ endDate: "not-a-date", phone: "+573000010004" }),
      row({ endDate: "2027-01-05", phone: "+573000010005" }),
    ];

    const result = await importPolicyRows(brokerId, rows);

    expect(result.totals).toEqual({ rows: 5, inserted: 4, updated: 0, failed: 1 });
    const failedRow = result.rows.find((r) => r.row === 4);
    expect(failedRow?.status).toBe("failed");
    if (failedRow?.status !== "failed") throw new Error("expected row 4 to fail");
    expect(failedRow.errors.some((e) => e.field === "endDate")).toBe(true);

    for (const goodRowNumber of [1, 2, 3, 5]) {
      const goodRow = result.rows.find((r) => r.row === goodRowNumber);
      expect(goodRow?.status).toBe("inserted");
      if (goodRow?.status === "failed") throw new Error("expected row to succeed");
      expect(goodRow?.policyId).toBeDefined();
      expect(goodRow?.contactId).toBeDefined();
    }
  });

  it("5.6: a new (broker_id, phone) pair with no existing contact creates one", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.6");
    const phone = "+573000020001";

    await importPolicyRows(brokerId, [row({ endDate: "2027-01-01", phone })]);

    const contacts = await admin.query("SELECT * FROM contacts WHERE broker_id = $1 AND phone = $2", [
      brokerId,
      phone,
    ]);
    expect(contacts.rows).toHaveLength(1);
  });

  it("5.7: a blank full_name cell does not erase an existing contact's full_name", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.7");
    const phone = "+573000030001";
    await insertContact(admin, brokerId, phone, { fullName: "Ana Ruiz" });

    await importPolicyRows(brokerId, [row({ endDate: "2027-01-01", phone, fullName: "" })]);

    const contacts = await admin.query<{ full_name: string }>(
      "SELECT full_name FROM contacts WHERE broker_id = $1 AND phone = $2",
      [brokerId, phone],
    );
    expect(contacts.rows[0].full_name).toBe("Ana Ruiz");
  });

  it("5.8: a DIFFERING full_name cell does not overwrite an existing contact's full_name (not erased, not merged)", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.8");
    const phone = "+573000030002";
    await insertContact(admin, brokerId, phone, { fullName: "Ana Ruiz" });

    await importPolicyRows(brokerId, [row({ endDate: "2027-01-01", phone, fullName: "Ana R." })]);

    const contacts = await admin.query<{ full_name: string }>(
      "SELECT full_name FROM contacts WHERE broker_id = $1 AND phone = $2",
      [brokerId, phone],
    );
    expect(contacts.rows[0].full_name).toBe("Ana Ruiz");
  });

  it("5.9: a previously-null doc_number is filled from the spreadsheet", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.9");
    const phone = "+573000030003";
    await insertContact(admin, brokerId, phone, { docNumber: null });

    await importPolicyRows(brokerId, [row({ endDate: "2027-01-01", phone, docNumber: "123456" })]);

    const contacts = await admin.query<{ doc_number: string }>(
      "SELECT doc_number FROM contacts WHERE broker_id = $1 AND phone = $2",
      [brokerId, phone],
    );
    expect(contacts.rows[0].doc_number).toBe("123456");
  });

  /**
   * task 5.11 — dedicated adversarial consent test, not folded into
   * 5.6-5.10. Asserts on the ACTUAL SQL issued by the import path, not
   * merely the end-state, by spying on `pg`'s `Client.prototype.query`
   * (the method every checked-out `PoolClient` shares, since `pg-pool`
   * hands out real `Client` instances under the hood) and inspecting every
   * INSERT/UPDATE statement's `.text` for a `consent_at` reference — see
   * file header for why this is necessary rather than only checking
   * `consent_at IS NULL`. Scoped to writes, not every query: this file's
   * own end-state SELECT below legitimately reads `consent_at`, and CI's
   * first run of this test proved a bare "any query" check catches that
   * unrelated read too, which has nothing to do with the invariant
   * (proposal P4 is about writes, not reads).
   *
   * **Verification convention (task 5.12): mutation testing, not RED.**
   * `consent_at` is unreachable by construction from `PolicyImportRow`
   * (Phase 2's schema has no `consent`/`acepta_terminos` field to parse in
   * the first place) — a literal RED before `upsertContact` existed would
   * have been trivially true for the wrong reason (the function itself
   * didn't exist yet), not because of anything specific to consent. Per
   * the `extraction-schemas` convention: this test file's own defect would
   * be caught by TEMPORARILY adding `consentAt: sql\`now()\`` to
   * `upsertContact`'s `.set()` in `import-policies-writer.ts`, confirming
   * this test fails, then reverting — **disclosed here as UNCONFIRMED in
   * this environment**, since no live Postgres connection is reachable to
   * run either the test or the mutation locally (see file header,
   * "BLOCKED in this environment"). Whoever runs this suite in CI and
   * finds it green on first execution MUST perform that mutation pass once
   * to confirm this test actually discriminates a real regression, per
   * this same disclosure convention `ingest-message.live.test.ts` and
   * `live-policy-number-unique-index.test.ts` both already use.
   */
  it("5.11/5.12: a file with an adversarial consent-looking column leaves consent_at NULL, and no write references consent_at", async () => {
    const querySpy = vi.spyOn(Client.prototype, "query");
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.11");
    const newPhone = "+573000040001";
    const existingPhone = "+573000040002";
    await insertContact(admin, brokerId, existingPhone, { fullName: "Existing Contact" });

    querySpy.mockClear();

    await importPolicyRows(brokerId, [
      row({ endDate: "2027-01-01", phone: newPhone, consent: "true" }),
      row({ endDate: "2027-01-02", phone: existingPhone, acepta_terminos: "2026-01-01" }),
    ]);

    // Positive control: this spy DID observe real writes for this test —
    // otherwise the negative assertion below would be vacuous.
    const insertContactCalls = querySpy.mock.calls.filter(([queryArg]) => {
      const text = typeof queryArg === "string" ? queryArg : (queryArg as { text?: string })?.text;
      return typeof text === "string" && /insert into "?contacts"?/i.test(text);
    });
    expect(insertContactCalls.length).toBeGreaterThan(0);

    // The invariant (proposal P4) is that the import path never WRITES
    // consent_at — a SELECT mentioning the column (e.g. this file's own
    // end-state verification query below) is unrelated and must not trip
    // this assertion. Scoping to INSERT/UPDATE statements is what makes
    // this a check on the invariant itself, not on every query anywhere
    // that happens to reference the column name.
    const writeQueryReferencesConsent = querySpy.mock.calls.some(([queryArg]) => {
      const text = typeof queryArg === "string" ? queryArg : (queryArg as { text?: string })?.text;
      if (typeof text !== "string") return false;
      const isWrite = /^\s*(insert into|update)\b/i.test(text);
      return isWrite && /consent_at/i.test(text);
    });
    expect(writeQueryReferencesConsent).toBe(false);

    const contacts = await admin.query<{ phone: string; consent_at: string | null }>(
      "SELECT phone, consent_at FROM contacts WHERE broker_id = $1 AND phone IN ($2, $3)",
      [brokerId, newPhone, existingPhone],
    );
    expect(contacts.rows).toHaveLength(2);
    for (const contactRow of contacts.rows) {
      expect(contactRow.consent_at).toBeNull();
    }
  });

  it("5.13: a non-null policy_number with no existing match inserts a new policies row", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.13");
    const policyNumber = `POL-5-13-${randomBytes(3).toString("hex")}`;

    const result = await importPolicyRows(brokerId, [
      row({ endDate: "2027-01-01", phone: "+573000050001", policyNumber }),
    ]);

    expect(result.rows[0].status).toBe("inserted");
    const policies = await admin.query("SELECT * FROM policies WHERE broker_id = $1 AND policy_number = $2", [
      brokerId,
      policyNumber,
    ]);
    expect(policies.rows).toHaveLength(1);
  });

  it("5.14: re-importing an unedited file updates, inserts nothing new, and leaves the row count unchanged", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.14");
    const policyNumber = `POL-5-14-${randomBytes(3).toString("hex")}`;
    const fileRows = [row({ endDate: "2027-01-01", phone: "+573000060001", policyNumber })];

    const first = await importPolicyRows(brokerId, fileRows);
    expect(first.totals).toEqual({ rows: 1, inserted: 1, updated: 0, failed: 0 });

    const beforeCount = await admin.query<{ count: string }>(
      "SELECT count(*) FROM policies WHERE broker_id = $1",
      [brokerId],
    );

    const second = await importPolicyRows(brokerId, fileRows);
    expect(second.totals).toEqual({ rows: 1, inserted: 0, updated: 1, failed: 0 });

    const afterCount = await admin.query<{ count: string }>(
      "SELECT count(*) FROM policies WHERE broker_id = $1",
      [brokerId],
    );
    expect(afterCount.rows[0].count).toBe(beforeCount.rows[0].count);
  });

  it("5.15: re-importing an edited file (same policy_number, different end_date) updates without duplication", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.15");
    const policyNumber = `POL-5-15-${randomBytes(3).toString("hex")}`;

    await importPolicyRows(brokerId, [
      row({ endDate: "2026-01-01", phone: "+573000070001", policyNumber }),
    ]);
    await importPolicyRows(brokerId, [
      row({ endDate: "2027-01-01", phone: "+573000070001", policyNumber }),
    ]);

    const policies = await admin.query<{ end_date: string }>(
      "SELECT end_date FROM policies WHERE broker_id = $1 AND policy_number = $2",
      [brokerId, policyNumber],
    );
    expect(policies.rows).toHaveLength(1);
    expect(new Date(policies.rows[0].end_date).toISOString().slice(0, 10)).toBe("2027-01-01");
  });

  it("5.17/5.18: a policy_number match against a different contact's phone fails the row and leaves the existing policy untouched", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.17");
    const policyNumber = `POL-5-17-${randomBytes(3).toString("hex")}`;
    const contact1Id = await insertContact(admin, brokerId, "+573000080001");
    await insertPolicy(admin, brokerId, contact1Id, policyNumber);
    // A different, already-existing contact whose phone the imported row
    // will resolve to.
    await insertContact(admin, brokerId, "+573000080002");

    const result = await importPolicyRows(brokerId, [
      row({ endDate: "2027-01-01", phone: "+573000080002", policyNumber }),
    ]);

    expect(result.rows[0].status).toBe("failed");
    if (result.rows[0].status !== "failed") throw new Error("expected the row to fail");
    expect(result.rows[0].errors.some((e) => e.field === "policyNumber")).toBe(true);

    const policies = await admin.query<{ contact_id: string }>(
      "SELECT contact_id FROM policies WHERE broker_id = $1 AND policy_number = $2",
      [brokerId, policyNumber],
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0].contact_id).toBe(contact1Id);
  });

  it("5.19: a row with no policy_number always inserts a new policies row and carries a non-idempotency warning", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.19");

    const result = await importPolicyRows(brokerId, [
      row({ endDate: "2027-01-01", phone: "+573000090001" }),
    ]);

    expect(result.rows[0].status).toBe("inserted");
    if (result.rows[0].status !== "inserted") throw new Error("expected inserted");
    expect(result.rows[0].warnings).toBeDefined();
    expect(result.rows[0].warnings?.length).toBeGreaterThan(0);

    const policies = await admin.query(
      "SELECT policy_number FROM policies WHERE broker_id = $1 AND policy_number IS NULL",
      [brokerId],
    );
    expect(policies.rows.length).toBeGreaterThan(0);
  });

  it("5.20: re-importing an identical unnumbered row creates a second, distinct policies row for the same contact", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.20");
    const phone = "+573000090002";
    const fileRows = [row({ endDate: "2027-01-01", phone })];

    const first = await importPolicyRows(brokerId, fileRows);
    const second = await importPolicyRows(brokerId, fileRows);

    expect(first.rows[0].status).toBe("inserted");
    expect(second.rows[0].status).toBe("inserted");
    if (first.rows[0].status !== "inserted" || second.rows[0].status !== "inserted") {
      throw new Error("expected both imports to insert");
    }
    expect(first.rows[0].warnings?.length).toBeGreaterThan(0);
    expect(second.rows[0].warnings?.length).toBeGreaterThan(0);

    const contacts = await admin.query<{ id: string }>(
      "SELECT id FROM contacts WHERE broker_id = $1 AND phone = $2",
      [brokerId, phone],
    );
    expect(contacts.rows).toHaveLength(1);

    const policies = await admin.query(
      "SELECT id FROM policies WHERE broker_id = $1 AND contact_id = $2 AND policy_number IS NULL",
      [brokerId, contacts.rows[0].id],
    );
    expect(policies.rows).toHaveLength(2);
  });

  it("5.22/5.23: a policy absent from a re-imported file is left completely untouched", async () => {
    const importPolicyRows = await loadImportPolicyRows();
    const brokerId = await insertBroker(admin, "Broker 5.22");
    const pol1Number = `POL-1-${randomBytes(3).toString("hex")}`;
    const pol2Number = `POL-2-${randomBytes(3).toString("hex")}`;
    const contact1Id = await insertContact(admin, brokerId, "+573000100001");
    const contact2Id = await insertContact(admin, brokerId, "+573000100002");
    await insertPolicy(admin, brokerId, contact1Id, pol1Number, "2026-01-01");
    await insertPolicy(admin, brokerId, contact2Id, pol2Number, "2026-06-01");

    const before = await admin.query("SELECT * FROM policies WHERE broker_id = $1 AND policy_number = $2", [
      brokerId,
      pol2Number,
    ]);

    await importPolicyRows(brokerId, [
      row({ endDate: "2027-01-01", phone: "+573000100001", policyNumber: pol1Number }),
    ]);

    const after = await admin.query("SELECT * FROM policies WHERE broker_id = $1 AND policy_number = $2", [
      brokerId,
      pol2Number,
    ]);
    expect(after.rows).toEqual(before.rows);

    const pol1After = await admin.query<{ end_date: string }>(
      "SELECT end_date FROM policies WHERE broker_id = $1 AND policy_number = $2",
      [brokerId, pol1Number],
    );
    expect(new Date(pol1After.rows[0].end_date).toISOString().slice(0, 10)).toBe("2027-01-01");
  });
});
