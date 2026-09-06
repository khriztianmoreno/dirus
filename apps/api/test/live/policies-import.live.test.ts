import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase 7 (tasks 7.1-7.3, proposal Success Criteria, spec "Import Runs
 * Within withBrokerContext and Respects RLS") — the end-to-end live proof
 * that the wired route (Phase 6), the per-row write loop (Phase 5), and RLS
 * (`0002_rls_policies.sql`) actually compose correctly against a real
 * Postgres. Every fixture in this file is dispatched through the REAL
 * `POST /admin/policies/import` route (`app.request(...)`), never by
 * calling `importPolicyRows` directly (that is Phase 5's own
 * `import-policies.live.test.ts`) and never by raw SQL inserts for the data
 * under test (only broker provisioning is raw SQL — out-of-band, mirroring
 * `webhook-ingress.live.test.ts`'s own "brokers themselves are provisioned
 * out-of-band" convention).
 *
 * **Convention mix, deliberately**: this suite needs BOTH a real RLS-bound
 * table owner (task 7.1's cross-tenant assertion, spec "Imported rows are
 * visible only under the importing broker's context") AND
 * `withBrokerContext`'s own real login role for the write path — so it
 * combines `live-rls-verification.test.ts`'s `OWNER_ROLE`/`APP_ROLE` split
 * (own role owns the tables so `FORCE ROW LEVEL SECURITY` actually binds
 * something) with `import-policies.live.test.ts`'s throwaway-schema
 * convention (never `public` — this suite has no dependency on
 * `0004_tenant_resolver.sql`'s `SECURITY DEFINER` function, which is the
 * only reason `webhook-ingress.live.test.ts` needed its own dedicated
 * database instead of a throwaway schema; `brokerId` here is an explicit
 * request field, never resolved from a webhook payload).
 *
 * **Two lessons carried over from this change's own Phase 5 CI round-trips**
 * (see `apply-progress.md`, Phase 5 section) and F2's Phase 5
 * (`whatsapp-webhook-ingress`'s archived `apply-progress.md`), both
 * deliberately avoided here:
 *
 *   1. Seeding as a role bound by `FORCE ROW LEVEL SECURITY` instead of a
 *      role that can actually bypass it for out-of-band setup. Every
 *      `brokers` row below is inserted directly via the `admin` connection
 *      (the same superuser-equivalent role `live-rls-verification.test.ts`
 *      and `webhook-ingress.live.test.ts` both use as their own `admin`
 *      handle), never via `OWNER_ROLE` (which, once `0002` applies, is
 *      itself FORCE-bound and has no `app.broker_id` set at seed time).
 *   2. Broker-wide assertions leaking across shared fixture state. Every
 *      `it()` below creates its OWN pair of brokers and scopes every
 *      assertion to those brokers' own ids — never a bare count across the
 *      whole throwaway schema.
 *
 * BLOCKED in this environment: no live Postgres connection is reachable —
 * verified directly before writing this file: `docker info` fails ("no
 * such file or directory" on the OrbStack socket — the daemon is not
 * running), no `podman`/`psql` binary exists, and `nc -z localhost 5432`
 * reports closed. `LIVE_TEST_DATABASE_URL` is unset here, so this entire
 * suite reports SKIPPED, not run. It must execute in CI. See this change's
 * `apply-progress.md`, Phase 7 section, for the full disclosure.
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../packages/db/migrations/${file}`, import.meta.url)),
    "utf8",
  );
}

function randomThrowawaySchemaName(): string {
  return `policy_import_live_${randomBytes(6).toString("hex")}`;
}

/** Same rewrite `packages/db/test/migrations/throwaway-schema.ts` performs, duplicated locally (see file header, F2/Phase 5 precedent — this file lives in `apps/api`, across the package boundary from that helper). */
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

const OWNER_ROLE = "policy_import_live_owner";
const OWNER_PASSWORD = "policy-import-live-owner-pass";
const APP_ROLE = "policy_import_live_app";
const APP_PASSWORD = "policy-import-live-app-pass";
const ADMIN_TOKEN = "a".repeat(32);

const HEADER_ROW = "insurer,line,endDate,phone,policyNumber";

/**
 * `phoneSchema` (`packages/schemas/src/primitives.ts`) requires digits only
 * after an optional `+` (`^\+?\d{7,15}$`). `randomBytes(n).toString("hex")`
 * can produce `a`-`f`, which CI's first run of this suite proved fails
 * validation on roughly a coin flip per generated number — a fixture bug,
 * not a production one. Generates a digits-only suffix instead.
 */
function randomDigits(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

function csvRow(overrides: { endDate?: string; phone: string; policyNumber?: string }): string {
  return `Sura,auto,${overrides.endDate ?? "2027-01-01"},${overrides.phone},${overrides.policyNumber ?? ""}`;
}

function buildXlsxFile(filename: string, rows: string[][]): File {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["insurer", "line", "endDate", "phone", "policyNumber"],
    ...rows,
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([buffer], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function insertBroker(client: Client, name: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ($1, $2, $3) RETURNING id",
    [name, `wa-${randomBytes(4).toString("hex")}`, `waba-${randomBytes(4).toString("hex")}`],
  );
  return result.rows[0].id;
}

/**
 * Builds a `createApp(...)` wired to the REAL `brokerExists` (`@dirus/db`)
 * and the REAL `importPolicyRows` (`import-policies-writer.ts`), connected
 * as `APP_ROLE` — the same non-superuser, `NOBYPASSRLS` role every write in
 * this suite goes through, mirroring production's `withBrokerContext` shape
 * exactly. `vi.resetModules()` first, per `import-policies.live.test.ts`'s
 * and `webhook-ingress.live.test.ts`'s established convention: `@dirus/db`
 * reads `DATABASE_URL` at import time.
 */
async function buildLiveApp() {
  vi.resetModules();
  process.env.DATABASE_URL = rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD);
  process.env.ALLOW_UNPOOLED_RUNTIME = "1";
  const { brokerExists } = await import("@dirus/db");
  const { importPolicyRows } = await import("../../src/services/import-policies-writer.js");
  const { createApp } = await import("../../src/app.js");
  const app = createApp({
    ingest: async () => ({ deduplicated: false }),
    resolveBrokerId: async () => undefined,
    webhookToken: "w".repeat(32),
    sendEcho: async () => undefined,
    adminToken: ADMIN_TOKEN,
    resolveBrokerExists: brokerExists,
    importPolicyRows,
  });
  return app;
}

type ImportResponseBody = {
  brokerId: string;
  totals: { rows: number; inserted: number; updated: number; failed: number };
  rows: unknown[];
};

async function postImport(
  app: Awaited<ReturnType<typeof buildLiveApp>>,
  opts: { brokerId?: string; file?: File; token?: string | undefined },
) {
  const form = new FormData();
  if (opts.brokerId !== undefined) form.set("brokerId", opts.brokerId);
  if (opts.file !== undefined) form.set("file", opts.file);
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["X-Dirus-Admin-Token"] = opts.token;
  return app.request("/admin/policies/import", { method: "POST", headers, body: form });
}

describe.skipIf(!liveUrl)("POST /admin/policies/import — live, end-to-end (Phase 7, tasks 7.1-7.3)", () => {
  let admin: Client;
  let schema: string;
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

    // 0000 (tables) and 0002 (RLS) applied AS the owning role, so
    // `FORCE ROW LEVEL SECURITY` binds a role distinct from `admin` and from
    // `APP_ROLE` (task 7.1's whole point). 0005 (this change's partial
    // unique index) applied the same way, since `importPolicyRows`'s upsert
    // depends on it existing. 0001 (vector extension) and 0004 (tenant
    // resolver, F2-only, hardcodes `public.brokers`) are irrelevant here —
    // this route never resolves a broker from a webhook payload.
    const owner = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, OWNER_PASSWORD) });
    await owner.connect();
    try {
      await owner.query(rewriteSchemaQualification(readMigration("0000_init.sql"), schema));
      await owner.query(rewriteSchemaQualification(readMigration("0002_rls_policies.sql"), schema));
      await owner.query(rewriteSchemaQualification(readMigration("0005_policy_number_unique_index.sql"), schema));
    } finally {
      await owner.end();
    }

    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}`);
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

  it(
    "7.1: broker A's imported rows are invisible under broker B's withBrokerContext scope, both seeded via the real route " +
      "(spec 'Imported rows are visible only under the importing broker's context')",
    async () => {
      const brokerAId = await insertBroker(admin, "Broker A (7.1)");
      const brokerBId = await insertBroker(admin, "Broker B (7.1)");
      const app = await buildLiveApp();

      const phoneA = `+5730001${randomDigits(6)}`;
      const phoneB = `+5730002${randomDigits(6)}`;

      const resA = await postImport(app, {
        brokerId: brokerAId,
        token: ADMIN_TOKEN,
        file: new File([[HEADER_ROW, csvRow({ phone: phoneA })].join("\n")], "policies-a.csv", {
          type: "text/csv",
        }),
      });
      expect(resA.status).toBe(200);
      const bodyA = (await resA.json()) as ImportResponseBody;
      expect(bodyA.totals).toEqual({ rows: 1, inserted: 1, updated: 0, failed: 0 });

      const resB = await postImport(app, {
        brokerId: brokerBId,
        token: ADMIN_TOKEN,
        file: new File([[HEADER_ROW, csvRow({ phone: phoneB })].join("\n")], "policies-b.csv", {
          type: "text/csv",
        }),
      });
      expect(resB.status).toBe(200);
      const bodyB = (await resB.json()) as ImportResponseBody;
      expect(bodyB.totals).toEqual({ rows: 1, inserted: 1, updated: 0, failed: 0 });

      // Positive control (not vacuous): broker A's rows genuinely exist,
      // verified via the `admin` connection, which bypasses RLS entirely.
      const adminCheck = await admin.query<{ count: string }>(
        "SELECT count(*) FROM policies WHERE broker_id = $1",
        [brokerAId],
      );
      expect(Number(adminCheck.rows[0].count)).toBeGreaterThan(0);

      // The RLS assertion: a real, non-bypass `APP_ROLE` session scoped to
      // broker B (via `set_config('app.broker_id', ...)`, exactly what
      // `withBrokerContext` does internally) reads its OWN rows (sanity —
      // an empty result set here would make the negative assertion below
      // vacuously true) but NONE of broker A's.
      const appConn = new Client({ connectionString: rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD) });
      await appConn.connect();
      try {
        await appConn.query("BEGIN");
        await appConn.query("SELECT set_config('app.broker_id', $1, true)", [brokerBId]);
        const contacts = await appConn.query<{ broker_id: string }>("SELECT broker_id FROM contacts");
        const policies = await appConn.query<{ broker_id: string }>("SELECT broker_id FROM policies");
        await appConn.query("COMMIT");

        expect(contacts.rows.length).toBeGreaterThan(0);
        expect(policies.rows.length).toBeGreaterThan(0);
        for (const r of [...contacts.rows, ...policies.rows]) {
          expect(r.broker_id).toBe(brokerBId);
          expect(r.broker_id).not.toBe(brokerAId);
        }
      } finally {
        await appConn.end();
      }
    },
  );

  it(
    "7.2: an equivalent CSV and XLSX both import successfully via the real route, creating contacts/policies rows with the correct broker_id " +
      "(proposal Success Criteria, first bullet)",
    async () => {
      const brokerId = await insertBroker(admin, "Broker 7.2");
      const app = await buildLiveApp();

      const phoneCsv = `+5730003${randomDigits(6)}`;
      const phoneXlsx = `+5730004${randomDigits(6)}`;

      const csvRes = await postImport(app, {
        brokerId,
        token: ADMIN_TOKEN,
        file: new File([[HEADER_ROW, csvRow({ phone: phoneCsv })].join("\n")], "policies.csv", {
          type: "text/csv",
        }),
      });
      expect(csvRes.status).toBe(200);
      const csvBody = (await csvRes.json()) as ImportResponseBody;
      expect(csvBody.totals).toEqual({ rows: 1, inserted: 1, updated: 0, failed: 0 });

      const xlsxRes = await postImport(app, {
        brokerId,
        token: ADMIN_TOKEN,
        file: buildXlsxFile("policies.xlsx", [["Sura", "auto", "2027-02-01", phoneXlsx, ""]]),
      });
      expect(xlsxRes.status).toBe(200);
      const xlsxBody = (await xlsxRes.json()) as ImportResponseBody;
      expect(xlsxBody.totals).toEqual({ rows: 1, inserted: 1, updated: 0, failed: 0 });

      const contacts = await admin.query<{ phone: string; broker_id: string }>(
        "SELECT phone, broker_id FROM contacts WHERE broker_id = $1 AND phone IN ($2, $3)",
        [brokerId, phoneCsv, phoneXlsx],
      );
      expect(contacts.rows).toHaveLength(2);
      for (const contactRow of contacts.rows) {
        expect(contactRow.broker_id).toBe(brokerId);
      }

      const policies = await admin.query<{ broker_id: string }>(
        "SELECT p.broker_id FROM policies p JOIN contacts c ON c.id = p.contact_id " +
          "WHERE p.broker_id = $1 AND c.phone IN ($2, $3)",
        [brokerId, phoneCsv, phoneXlsx],
      );
      expect(policies.rows).toHaveLength(2);
    },
  );

  it(
    "7.3: a request with a wrong or missing admin token returns 401 and writes zero contacts/policies rows, checked directly against the database " +
      "(proposal Success Criteria, 'A request with a wrong or missing admin token gets 401 with no rows written')",
    async () => {
      const brokerId = await insertBroker(admin, "Broker 7.3");
      const app = await buildLiveApp();
      const phone = `+5730005${randomDigits(6)}`;
      const file = new File([[HEADER_ROW, csvRow({ phone })].join("\n")], "policies.csv", { type: "text/csv" });

      const wrongTokenRes = await postImport(app, { brokerId, token: "wrong-token-wrong-length", file });
      expect(wrongTokenRes.status).toBe(401);

      const missingTokenRes = await postImport(app, { brokerId, token: undefined, file });
      expect(missingTokenRes.status).toBe(401);

      const contacts = await admin.query<{ count: string }>(
        "SELECT count(*) FROM contacts WHERE broker_id = $1",
        [brokerId],
      );
      expect(contacts.rows[0].count).toBe("0");

      const policies = await admin.query<{ count: string }>(
        "SELECT count(*) FROM policies WHERE broker_id = $1",
        [brokerId],
      );
      expect(policies.rows[0].count).toBe("0");
    },
  );
});
