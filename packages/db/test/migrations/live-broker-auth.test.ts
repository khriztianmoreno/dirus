import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertThrowawayDatabase } from "./assert-throwaway-database.js";

/**
 * `admin-dashboard` (C1), design.md D-A (status: NEEDS EMPIRICAL PROOF) and
 * data-model spec "magic_link_tokens Is RLS-Scoped..."/broker-auth spec
 * "Token Is Never Stored Raw": the five live assertions D-A names as the
 * acceptance gate, verbatim, cross-referenced by number below (tasks.md task
 * 1.6), plus tasks 1.8 and 1.9's two additional live proofs (plain unique
 * index on email; raw token never stored).
 *
 * Why this file targets its OWN dedicated database
 * (`BROKER_AUTH_TEST_DATABASE_URL`), not the shared `LIVE_TEST_DATABASE_URL`
 * throwaway-schema convention `live-rls-verification.test.ts` and
 * `rls-catalog-guard.test.ts` use — identical reasoning to
 * `live-tenant-resolution.test.ts`'s file header for 0004, restated here
 * because it applies again: `0006_broker_auth.sql`'s three `SECURITY
 * DEFINER` function bodies deliberately hardcode `public.broker_users`,
 * `public.magic_link_tokens`, `public.sessions` (schema-qualified, not just
 * the bare table name) — that qualification is itself the search_path-hijack
 * defense design.md D-A/D-H names. `throwaway-schema.ts`'s
 * `rewriteSchemaQualification` only rewrites FK `REFERENCES "public".`
 * clauses; it does not, and must not, rewrite a hand-written `public.*`
 * reference inside a function body, because doing so would defeat the very
 * thing being tested. This file instead mirrors
 * `live-tenant-resolution.test.ts`'s established pattern exactly: its own
 * disposable database, migrations applied directly to that database's real
 * `public` schema, full teardown in `afterAll`.
 *
 * DEVIATION, disclosed (tasks.md task 1.4 literally says "extend
 * rls-catalog-guard.test.ts"): task 1.4's catalog-guard checks (assertion 4
 * below) are folded into THIS file rather than extending
 * `rls-catalog-guard.test.ts`, for the same reason `live-tenant-resolution.test.ts`'s
 * header documents for 0004/task 1.4 of that change's own task list.
 * `rls-catalog-guard.test.ts` applies migrations into a randomly-named
 * throwaway schema (never `public`), which is incompatible with this
 * migration's schema-qualified `public.*` function bodies for the identical
 * reason stated above — applying `0006_broker_auth.sql` unmodified into a
 * throwaway schema would leave its functions resolving against a
 * `public.broker_users` that does not exist in that scenario. Building a
 * second, disjoint fixture just to host the catalog-only checks would
 * duplicate this file's `beforeAll`/`afterAll` for no isolation benefit,
 * exactly as `live-tenant-resolution.test.ts` reasons for 0004. See
 * apply-progress.md for the record of this decision.
 *
 * For the same reason, and mirroring `live-tenant-resolution.test.ts`'s /
 * `migrate-runner-live.test.ts`'s precedent, this suite creates and drops a
 * role literally named `dirus_app` against its own single-purpose, fully
 * torn-down database — not the shared `dirus_test` database
 * `rls-catalog-guard.test.ts`'s Judgment Day round 4 forbids that pattern
 * against.
 */
const liveUrl = process.env.BROKER_AUTH_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const OWNER_ROLE = "broker_auth_owner";
const OWNER_PASSWORD = "broker-auth-owner-pass";
const APP_PASSWORD = "broker-auth-app-pass";

/** Rebuilds a connection string with a different user/password, same host/db. */
function rewriteUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

describe.skipIf(!liveUrl)("live broker auth against 0000/0002/0004/0006 (design D-A gate)", () => {
  let admin: Client;
  let brokerAId: string;
  let brokerBId: string;
  let brokerUserAId: string;
  // Judgment Day convention (live-rls-verification.test.ts,
  // live-tenant-resolution.test.ts): only true once assertThrowawayDatabase
  // and this run's own setup have both succeeded. `afterAll` refuses to run
  // any destructive statement until then.
  let safeToMutate = false;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    await assertThrowawayDatabase(admin);

    // Idempotent local re-run cleanup.
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query("DROP ROLE IF EXISTS dirus_app");
    await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
    await admin.query("DROP ROLE IF EXISTS dirus_tenant_resolver");

    safeToMutate = true;

    await admin.query(`CREATE ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE ROLE dirus_app WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER_ROLE}`);

    // 0000/0002 applied AS the non-superuser owner — ownership is what FORCE
    // binds. Applied to this database's real `public` schema.
    const owner = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, OWNER_PASSWORD) });
    await owner.connect();
    try {
      await owner.query(readMigration("0000_init.sql"));
      await owner.query(readMigration("0002_rls_policies.sql"));
    } finally {
      await owner.end();
    }

    // 0004 (creates dirus_tenant_resolver, the role 0006 extends) and 0006
    // applied AS admin (superuser): CREATE POLICY requires table ownership
    // or superuser, and both migrations' role/membership statements need
    // CREATEROLE — admin already holds both.
    await admin.query(readMigration("0004_tenant_resolver.sql"));
    await admin.query(readMigration("0006_broker_auth.sql"));

    // Least-privilege dirus_app grants (mirrors 0003_app_role_grants.sql's
    // shape; 0003 itself is not applied here — see
    // live-tenant-resolution.test.ts's identical note on why USAGE is not
    // optional after a hand-created schema).
    await admin.query(`GRANT USAGE ON SCHEMA public TO dirus_app`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dirus_app`);

    // Fixture: two brokers (A, B), one broker_users row each with an email,
    // seeded directly as admin (superuser bypasses RLS outright).
    const seedA = await admin.query<{ id: string }>(
      "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ('Broker A', 'ba-phoneA', 'ba-wabaA') RETURNING id",
    );
    brokerAId = seedA.rows[0].id;
    const seedB = await admin.query<{ id: string }>(
      "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ('Broker B', 'ba-phoneB', 'ba-wabaB') RETURNING id",
    );
    brokerBId = seedB.rows[0].id;

    const userA = await admin.query<{ id: string }>(
      "INSERT INTO broker_users (broker_id, name, phone, email) VALUES ($1, 'Alice', 'ba-phone-alice', 'alice@example.com') RETURNING id",
      [brokerAId],
    );
    brokerUserAId = userA.rows[0].id;
    await admin.query(
      "INSERT INTO broker_users (broker_id, name, phone, email) VALUES ($1, 'Bob', 'ba-phone-bob', 'bob@example.com')",
      [brokerBId],
    );
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

  describe("1. positive: each resolver function returns the expected broker_id with no app.broker_id set", () => {
    it("dirus_resolve_broker_id_by_email", async () => {
      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        const result = await app.query<{ dirus_resolve_broker_id_by_email: string | null }>(
          "SELECT dirus_resolve_broker_id_by_email('alice@example.com')",
        );
        expect(result.rows[0].dirus_resolve_broker_id_by_email).toBe(brokerAId);
      } finally {
        await app.end();
      }
    });

    it("dirus_resolve_broker_id_by_magic_link", async () => {
      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = sha256Hex(rawToken);
      await admin.query(
        "INSERT INTO magic_link_tokens (broker_id, broker_user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '15 minutes')",
        [brokerAId, brokerUserAId, tokenHash],
      );

      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        const result = await app.query<{ dirus_resolve_broker_id_by_magic_link: string | null }>(
          "SELECT dirus_resolve_broker_id_by_magic_link($1)",
          [tokenHash],
        );
        expect(result.rows[0].dirus_resolve_broker_id_by_magic_link).toBe(brokerAId);
      } finally {
        await app.end();
      }
    });

    it("dirus_resolve_broker_id_by_session", async () => {
      const rawSession = randomBytes(32).toString("base64url");
      const sessionHash = sha256Hex(rawSession);
      await admin.query(
        "INSERT INTO sessions (broker_id, broker_user_id, session_token_hash, csrf_token_hash, idle_expires_at) VALUES ($1, $2, $3, $4, now() + interval '7 days')",
        [brokerAId, brokerUserAId, sessionHash, sha256Hex(randomBytes(32).toString("base64url"))],
      );

      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        const result = await app.query<{ dirus_resolve_broker_id_by_session: string | null }>(
          "SELECT dirus_resolve_broker_id_by_session($1)",
          [sessionHash],
        );
        expect(result.rows[0].dirus_resolve_broker_id_by_session).toBe(brokerAId);
      } finally {
        await app.end();
      }
    });
  });

  it("2. negative control (the whole point): the same session that just resolved still sees zero rows on broker_users, sessions, and magic_link_tokens directly", async () => {
    const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await app.connect();
    try {
      const resolved = await app.query<{ dirus_resolve_broker_id_by_email: string | null }>(
        "SELECT dirus_resolve_broker_id_by_email('alice@example.com')",
      );
      expect(resolved.rows[0].dirus_resolve_broker_id_by_email).toBe(brokerAId);

      // Same session, same connection, immediately after each function
      // call — the exact ordering the spec scenario requires. Non-zero on
      // any of the three is a stop-ship signal per tasks.md's ordering
      // constraint.
      const brokerUsersCount = await app.query("SELECT count(*) FROM broker_users");
      expect(brokerUsersCount.rows[0].count).toBe("0");
      const sessionsCount = await app.query("SELECT count(*) FROM sessions");
      expect(sessionsCount.rows[0].count).toBe("0");
      const tokensCount = await app.query("SELECT count(*) FROM magic_link_tokens");
      expect(tokensCount.rows[0].count).toBe("0");
    } finally {
      await app.end();
    }
  });

  describe("3. miss: an unknown key returns NULL, not an error", () => {
    it("dirus_resolve_broker_id_by_email", async () => {
      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        const result = await app.query<{ dirus_resolve_broker_id_by_email: string | null }>(
          "SELECT dirus_resolve_broker_id_by_email('unknown@example.com')",
        );
        expect(result.rows[0].dirus_resolve_broker_id_by_email).toBeNull();
      } finally {
        await app.end();
      }
    });

    it("dirus_resolve_broker_id_by_magic_link", async () => {
      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        const result = await app.query<{ dirus_resolve_broker_id_by_magic_link: string | null }>(
          "SELECT dirus_resolve_broker_id_by_magic_link('unknown-hash')",
        );
        expect(result.rows[0].dirus_resolve_broker_id_by_magic_link).toBeNull();
      } finally {
        await app.end();
      }
    });

    it("dirus_resolve_broker_id_by_session", async () => {
      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        const result = await app.query<{ dirus_resolve_broker_id_by_session: string | null }>(
          "SELECT dirus_resolve_broker_id_by_session('unknown-hash')",
        );
        expect(result.rows[0].dirus_resolve_broker_id_by_session).toBeNull();
      } finally {
        await app.end();
      }
    });
  });

  describe("4. catalog guard (folded from task 1.4, see file header for the disclosed deviation)", () => {
    it("each new policy's TO clause names only dirus_tenant_resolver", async () => {
      const result = await admin.query<{ tablename: string; roles: string }>(
        `SELECT tablename, array_to_string(roles, ',') AS roles FROM pg_policies
         WHERE policyname = 'tenant_resolver_lookup' AND tablename IN ('broker_users', 'magic_link_tokens', 'sessions')
         ORDER BY tablename`,
      );
      expect(result.rows).toHaveLength(3);
      for (const row of result.rows) {
        expect(row.roles).toBe("dirus_tenant_resolver");
      }
    });

    it("each new function is SECURITY DEFINER, owned by dirus_tenant_resolver, with a pinned empty search_path, returning a bare uuid", async () => {
      const result = await admin.query<{
        proname: string;
        prosecdef: boolean;
        owner: string;
        rettype: string;
        proconfig: string[] | null;
      }>(`
        SELECT p.proname, p.prosecdef, r.rolname AS owner, t.typname AS rettype, p.proconfig
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
        JOIN pg_type t ON t.oid = p.prorettype
        WHERE p.proname IN (
          'dirus_resolve_broker_id_by_email',
          'dirus_resolve_broker_id_by_magic_link',
          'dirus_resolve_broker_id_by_session'
        )
        ORDER BY p.proname
      `);
      expect(result.rows).toHaveLength(3);
      for (const row of result.rows) {
        expect(row.prosecdef).toBe(true);
        expect(row.owner).toBe("dirus_tenant_resolver");
        expect(row.rettype).toBe("uuid");
        expect(row.proconfig).not.toBeNull();
        expect(row.proconfig).toContain('search_path=""');
      }
    });

    it("EXECUTE is revoked from PUBLIC and granted only to dirus_app on all three functions", async () => {
      for (const fn of [
        "dirus_resolve_broker_id_by_email(text)",
        "dirus_resolve_broker_id_by_magic_link(text)",
        "dirus_resolve_broker_id_by_session(text)",
      ]) {
        const publicHas = await admin.query<{ has: boolean }>(
          `SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS has`,
        );
        expect(publicHas.rows[0].has).toBe(false);
        const appHas = await admin.query<{ has: boolean }>(
          `SELECT has_function_privilege('dirus_app', '${fn}', 'EXECUTE') AS has`,
        );
        expect(appHas.rows[0].has).toBe(true);
      }
    });

    it("dirus_app holds no inheriting membership in dirus_tenant_resolver", async () => {
      const result = await admin.query<{ member: string; inherit_option: boolean }>(`
        SELECT m.rolname AS member, am.inherit_option
        FROM pg_auth_members am
        JOIN pg_roles r ON r.oid = am.roleid
        JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = 'dirus_tenant_resolver'
      `);
      const inheriting = result.rows.filter((row) => row.inherit_option);
      expect(inheriting).toEqual([]);
      expect(result.rows.some((row) => row.member === "dirus_app")).toBe(false);
    });
  });

  describe("5. cross-tenant, end-to-end (the non-negotiable success criterion)", () => {
    it("a session issued for broker A reads zero of broker B's extractions and renewals, with a positive control", async () => {
      // Direct-insert fixture data for both brokers (admin/superuser
      // bypasses RLS outright), mirroring
      // live-policy-number-unique-index.test.ts's per-test fixture
      // discipline: every row scoped by a broker_id unique to this test,
      // never a bare cross-suite count.
      const contactA = randomUUID();
      const contactB = randomUUID();
      await admin.query("INSERT INTO contacts (id, broker_id, phone) VALUES ($1, $2, $3)", [
        contactA,
        brokerAId,
        "ba-contact-a",
      ]);
      await admin.query("INSERT INTO contacts (id, broker_id, phone) VALUES ($1, $2, $3)", [
        contactB,
        brokerBId,
        "ba-contact-b",
      ]);

      const documentA = randomUUID();
      const documentB = randomUUID();
      await admin.query(
        "INSERT INTO documents (id, broker_id, contact_id, r2_key, mime_type) VALUES ($1, $2, $3, 'a/doc.pdf', 'application/pdf')",
        [documentA, brokerAId, contactA],
      );
      await admin.query(
        "INSERT INTO documents (id, broker_id, contact_id, r2_key, mime_type) VALUES ($1, $2, $3, 'b/doc.pdf', 'application/pdf')",
        [documentB, brokerBId, contactB],
      );

      await admin.query(
        "INSERT INTO extractions (id, broker_id, document_id, model, output, confidence) VALUES ($1, $2, $3, 'gemini-3.1-flash', '{}'::jsonb, '{}'::jsonb)",
        [randomUUID(), brokerAId, documentA],
      );
      await admin.query(
        "INSERT INTO extractions (id, broker_id, document_id, model, output, confidence) VALUES ($1, $2, $3, 'gemini-3.1-flash', '{}'::jsonb, '{}'::jsonb)",
        [randomUUID(), brokerBId, documentB],
      );

      const policyA = randomUUID();
      const policyB = randomUUID();
      await admin.query(
        "INSERT INTO policies (id, broker_id, contact_id, insurer, line, end_date) VALUES ($1, $2, $3, 'Sura', 'auto', '2027-01-01')",
        [policyA, brokerAId, contactA],
      );
      await admin.query(
        "INSERT INTO policies (id, broker_id, contact_id, insurer, line, end_date) VALUES ($1, $2, $3, 'Sura', 'auto', '2027-01-01')",
        [policyB, brokerBId, contactB],
      );
      await admin.query(
        "INSERT INTO renewals (id, broker_id, policy_id, due_date) VALUES ($1, $2, $3, '2027-01-01')",
        [randomUUID(), brokerAId, policyA],
      );
      await admin.query(
        "INSERT INTO renewals (id, broker_id, policy_id, due_date) VALUES ($1, $2, $3, '2027-01-01')",
        [randomUUID(), brokerBId, policyB],
      );

      // Issue a real session for broker A via a direct insert (this phase
      // does not yet have the callback route — that is Phase 3), resolve it
      // through the exported function's SQL, then open a transaction with
      // app.broker_id set to the resolved value, exactly as design.md's
      // "EVERY DASHBOARD REQUEST" data-flow diagram states.
      const rawSession = randomBytes(32).toString("base64url");
      const sessionHash = sha256Hex(rawSession);
      await admin.query(
        "INSERT INTO sessions (broker_id, broker_user_id, session_token_hash, csrf_token_hash, idle_expires_at) VALUES ($1, $2, $3, $4, now() + interval '7 days')",
        [brokerAId, brokerUserAId, sessionHash, sha256Hex(randomBytes(32).toString("base64url"))],
      );

      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        const resolved = await app.query<{ dirus_resolve_broker_id_by_session: string | null }>(
          "SELECT dirus_resolve_broker_id_by_session($1)",
          [sessionHash],
        );
        expect(resolved.rows[0].dirus_resolve_broker_id_by_session).toBe(brokerAId);

        await app.query("BEGIN");
        try {
          await app.query("SELECT set_config('app.broker_id', $1, true)", [brokerAId]);

          const extractions = await app.query("SELECT broker_id::text FROM extractions");
          expect(extractions.rows.map((r) => r.broker_id)).toEqual([brokerAId]);

          const renewals = await app.query("SELECT broker_id::text FROM renewals");
          expect(renewals.rows.map((r) => r.broker_id)).toEqual([brokerAId]);

          // Positive control: broker A's own rows ARE visible — proves the
          // negative assertions above are not vacuous (an always-empty
          // result set would also "pass" a naive zero-of-B's-rows check).
          expect(extractions.rows).toHaveLength(1);
          expect(renewals.rows).toHaveLength(1);
        } finally {
          await app.query("ROLLBACK");
        }
      } finally {
        await app.end();
      }
    });
  });

  describe("task 1.8: broker_users.email is a PLAIN, globally unique index (not scoped per broker)", () => {
    it("multiple broker_users rows with email IS NULL coexist for the same broker", async () => {
      const brokerId = randomUUID();
      await admin.query("INSERT INTO brokers (id, name, wa_phone_number_id, waba_id) VALUES ($1, 'Broker Null', $2, $3)", [
        brokerId,
        "ba-null-phone",
        "ba-null-waba",
      ]);
      await admin.query("INSERT INTO broker_users (broker_id, name, phone, email) VALUES ($1, 'No Email 1', $2, NULL)", [
        brokerId,
        "ba-null-1",
      ]);
      await admin.query("INSERT INTO broker_users (broker_id, name, phone, email) VALUES ($1, 'No Email 2', $2, NULL)", [
        brokerId,
        "ba-null-2",
      ]);

      const rows = await admin.query("SELECT count(*) FROM broker_users WHERE broker_id = $1 AND email IS NULL", [
        brokerId,
      ]);
      expect(rows.rows[0].count).toBe("2");
    });

    it("a duplicate non-null email across two different brokers is rejected", async () => {
      await expect(
        admin.query("INSERT INTO broker_users (broker_id, name, phone, email) VALUES ($1, 'Alice Clone', $2, $3)", [
          brokerBId,
          "ba-phone-alice-clone",
          "alice@example.com",
        ]),
      ).rejects.toThrow(/duplicate key value violates unique constraint/i);
    });
  });

  describe("task 1.9: the raw token is never stored", () => {
    it("only token_hash is persisted for a magic-link token; no column carries the raw value", async () => {
      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = sha256Hex(rawToken);
      const inserted = await admin.query<{ id: string }>(
        "INSERT INTO magic_link_tokens (broker_id, broker_user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '15 minutes') RETURNING id",
        [brokerAId, brokerUserAId, tokenHash],
      );

      const row = await admin.query("SELECT * FROM magic_link_tokens WHERE id = $1", [inserted.rows[0].id]);
      expect(row.rows[0].token_hash).toBe(tokenHash);
      expect(row.rows[0].token_hash).not.toBe(rawToken);
      for (const value of Object.values(row.rows[0])) {
        expect(String(value)).not.toBe(rawToken);
      }
    });

    it("only session_token_hash/csrf_token_hash are persisted for a session; no column carries either raw value", async () => {
      const rawSession = randomBytes(32).toString("base64url");
      const rawCsrf = randomBytes(32).toString("base64url");
      const sessionHash = sha256Hex(rawSession);
      const csrfHash = sha256Hex(rawCsrf);
      const inserted = await admin.query<{ id: string }>(
        "INSERT INTO sessions (broker_id, broker_user_id, session_token_hash, csrf_token_hash, idle_expires_at) VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING id",
        [brokerAId, brokerUserAId, sessionHash, csrfHash],
      );

      const row = await admin.query("SELECT * FROM sessions WHERE id = $1", [inserted.rows[0].id]);
      expect(row.rows[0].session_token_hash).toBe(sessionHash);
      expect(row.rows[0].csrf_token_hash).toBe(csrfHash);
      for (const value of Object.values(row.rows[0])) {
        expect(String(value)).not.toBe(rawSession);
        expect(String(value)).not.toBe(rawCsrf);
      }
    });
  });
});
