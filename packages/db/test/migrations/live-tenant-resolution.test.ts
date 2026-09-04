import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertThrowawayDatabase } from "./assert-throwaway-database.js";

/**
 * design.md D-1 (status: NEEDS EMPIRICAL PROOF) and data-model spec
 * "Data Model Delta: Tenant Resolver Role": the five live assertions D-1
 * names as the acceptance gate, verbatim, plus the catalog-derived checks
 * task 1.4 (tasks.md) calls for (proconfig, EXECUTE grantee, `pg_auth_members`
 * inheriting-membership guard) and the two live scenarios the data-model
 * delta spec adds (suspended broker still resolves; hijack-resistant
 * search_path). Task 1.4 explicitly allows folding its catalog guard into a
 * sibling file rather than extending `rls-catalog-guard.test.ts` verbatim —
 * this file IS that sibling: it needs the exact same live fixture 1.6
 * requires anyway (brokers table, RLS, the resolver role/policy/function),
 * so building a second, disjoint fixture just to host the catalog-only
 * checks would duplicate `beforeAll`/`afterAll` for no isolation benefit.
 * See apply-progress.md for that decision.
 *
 * Why this file targets its OWN dedicated database
 * (`TENANT_RESOLVER_TEST_DATABASE_URL`), not the shared `LIVE_TEST_DATABASE_URL`
 * throwaway-schema convention `live-rls-verification.test.ts` and
 * `rls-catalog-guard.test.ts` use: `0004_tenant_resolver.sql`'s
 * `SECURITY DEFINER` function body deliberately hardcodes
 * `public.brokers` (schema-qualified, not just `brokers`) — that
 * qualification is itself the search_path-hijack defense design.md D-1
 * names. `throwaway-schema.ts`'s `rewriteSchemaQualification` only rewrites
 * FK `REFERENCES "public".` clauses (0000_init.sql's shape); it does not,
 * and must not, rewrite a hand-written `public.brokers` reference inside a
 * function body, because doing so would defeat the very thing being tested.
 * Applying this migration set to a randomly-named throwaway schema would
 * therefore leave the function resolving against a `public.brokers` that
 * does not exist in that scenario. This file instead mirrors
 * `migrate-runner-live.test.ts`'s established pattern exactly: its own
 * disposable database, migrations applied directly to that database's real
 * `public` schema, full teardown (`DROP SCHEMA public CASCADE` +
 * `CREATE SCHEMA public`) in `afterAll`.
 *
 * For the same reason, and mirroring `migrate-runner-live.test.ts`'s
 * precedent (the only other file in this repo that does this), this suite
 * creates and drops a role literally named `dirus_app` — the real
 * production role name. `rls-catalog-guard.test.ts`'s Judgment Day round 4
 * forbids that pattern against the SHARED `dirus_test` database specifically
 * because roles are cluster-global and a crashed run could leave (or drop) a
 * real deployed role sharing that cluster. This suite's target database is
 * its own single-purpose, fully-torn-down database inside the same ephemeral
 * CI container `migrate-runner-live.test.ts` already uses that way — the
 * risk that precedent guards against does not apply here for the same reason
 * it does not apply there. A literal `dirus_app` role is also required to
 * exercise 0004's own `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname =
 * 'dirus_app')` guard for real, and the negative control's wording
 * ("dirus_app ... still sees zero rows") is about that literal role.
 */
const liveUrl = process.env.TENANT_RESOLVER_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}

const OWNER_ROLE = "phase1_owner";
const OWNER_PASSWORD = "phase1-owner-pass";
const APP_PASSWORD = "phase1-app-pass";

/** Rebuilds a connection string with a different user/password, same host/db. */
function rewriteUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

describe.skipIf(!liveUrl)("live tenant resolution against 0000/0002/0004 (design D-1 gate)", () => {
  let admin: Client;
  let brokerAId: string;
  let brokerSuspendedId: string;
  // Judgment Day round 4 convention (live-rls-verification.test.ts,
  // rls-catalog-guard.test.ts): only true once assertThrowawayDatabase and
  // this run's own setup have both succeeded. `afterAll` refuses to run any
  // destructive statement until then.
  let safeToMutate = false;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    await assertThrowawayDatabase(admin);

    // Idempotent local re-run cleanup (a possibly-crashed prior run's
    // leftover roles). This database is single-purpose per
    // TENANT_RESOLVER_TEST_DATABASE_URL — see file header — so a full
    // schema reset plus role drop is the right cleanup shape, mirroring
    // migrate-runner-live.test.ts's afterAll exactly.
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query("DROP ROLE IF EXISTS dirus_app");
    await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
    await admin.query("DROP ROLE IF EXISTS dirus_tenant_resolver");

    safeToMutate = true;

    // Non-superuser, non-BYPASSRLS owner — FORCE ROW LEVEL SECURITY only has
    // teeth against a non-superuser owner (a superuser bypasses RLS
    // outright, FORCE or not). Mirrors live-rls-verification.test.ts's
    // OWNER_ROLE.
    await admin.query(`CREATE ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    // The literal production role name — see file header for why this file
    // (unlike rls-catalog-guard.test.ts) may create it.
    await admin.query(`CREATE ROLE dirus_app WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER_ROLE}`);

    // 0000/0002 applied AS the non-superuser owner — ownership is what FORCE
    // binds. Applied to this database's real `public` schema (no
    // schema-qualification rewrite; see file header).
    const owner = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, OWNER_PASSWORD) });
    await owner.connect();
    try {
      await owner.query(readMigration("0000_init.sql"));
      await owner.query(readMigration("0002_rls_policies.sql"));
    } finally {
      await owner.end();
    }

    // 0004 applied AS admin (superuser): CREATE POLICY requires table
    // ownership or superuser, and 0004's role/membership statements need
    // CREATEROLE — admin already holds both, unconditionally, without
    // granting CREATEROLE to a fixture role just for this test. Because
    // `dirus_app` already exists (created above), 0004's own
    // `IF EXISTS (... rolname = 'dirus_app')` guard is exercised for real —
    // this is the actual production DO block, not a hand-rolled stand-in.
    await admin.query(readMigration("0004_tenant_resolver.sql"));

    // Least-privilege dirus_app grants on the other tables (mirrors
    // 0003_app_role_grants.sql's shape; 0003 itself is not applied here —
    // only 0000/0002/0004 are this gate's concern).
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dirus_app`);

    // Seed fixture: two brokers, one active (matched by the positive/
    // negative-control/search_path-hijack assertions) and one suspended
    // (data-model spec "A suspended broker still resolves" / P5). Seeded
    // directly as admin (superuser bypasses RLS outright), not via
    // app.broker_id ceremony — simpler and does not exercise anything these
    // assertions are about.
    const seedA = await admin.query<{ id: string }>(
      "INSERT INTO brokers (name, wa_phone_number_id, waba_id) VALUES ('Broker A', 'phoneA', 'wabaA') RETURNING id",
    );
    brokerAId = seedA.rows[0].id;
    const seedS = await admin.query<{ id: string }>(
      "INSERT INTO brokers (name, wa_phone_number_id, waba_id, status) VALUES ('Broker S', 'phoneS', 'wabaS', 'suspended') RETURNING id",
    );
    brokerSuspendedId = seedS.rows[0].id;
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      if (safeToMutate) {
        // Full teardown: this database is single-purpose per
        // TENANT_RESOLVER_TEST_DATABASE_URL (see file header) and is
        // destroyed with the CI job regardless, but idempotent local re-runs
        // still depend on this.
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

  it("1. positive: dirus_app with no app.broker_id set resolves a known broker", async () => {
    const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await app.connect();
    try {
      const result = await app.query<{ dirus_resolve_broker_id: string | null }>(
        "SELECT dirus_resolve_broker_id('phoneA')",
      );
      expect(result.rows[0].dirus_resolve_broker_id).toBe(brokerAId);
    } finally {
      await app.end();
    }
  });

  it("2. negative control (the whole point): the same session that just resolved a broker still sees zero brokers rows directly", async () => {
    const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await app.connect();
    try {
      const resolved = await app.query<{ dirus_resolve_broker_id: string | null }>(
        "SELECT dirus_resolve_broker_id('phoneA')",
      );
      expect(resolved.rows[0].dirus_resolve_broker_id).toBe(brokerAId);

      // Same session, same connection, immediately after — the exact
      // ordering the spec scenario requires.
      const count = await app.query("SELECT count(*) FROM brokers");
      expect(count.rows[0].count).toBe("0");
      const star = await app.query("SELECT * FROM brokers");
      expect(star.rows).toHaveLength(0);
    } finally {
      await app.end();
    }
  });

  it("3. miss: an unknown key resolves to NULL, not an error", async () => {
    const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await app.connect();
    try {
      const result = await app.query<{ dirus_resolve_broker_id: string | null }>(
        "SELECT dirus_resolve_broker_id('unknown')",
      );
      expect(result.rows[0].dirus_resolve_broker_id).toBeNull();
    } finally {
      await app.end();
    }
  });

  it("4. owner control: the same lookup through an owner-owned SECURITY DEFINER function returns NULL (FORCE binds the owner)", async () => {
    // Constructed inline, not reusing 0004's function — a separate function,
    // same body, owned by the TABLE owner (OWNER_ROLE) instead of
    // dirus_tenant_resolver.
    await admin.query(`
      CREATE FUNCTION public.owner_owned_probe(p_key text) RETURNS uuid
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = ''
      AS $$ SELECT id FROM public.brokers WHERE wa_phone_number_id = p_key $$;
    `);
    await admin.query(`ALTER FUNCTION public.owner_owned_probe(text) OWNER TO ${OWNER_ROLE}`);
    try {
      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        const result = await app.query<{ owner_owned_probe: string | null }>(
          "SELECT owner_owned_probe('phoneA')",
        );
        // Re-proves FORCE ROW LEVEL SECURITY binds the table owner even
        // though the function returns a known key: the resolver role's
        // non-ownership, not SECURITY DEFINER alone, is what makes 0004's
        // function work.
        expect(result.rows[0].owner_owned_probe).toBeNull();
      } finally {
        await app.end();
      }
    } finally {
      await admin.query("DROP FUNCTION public.owner_owned_probe(text)");
    }
  });

  it("5. membership guard: dirus_app holds no inheriting membership in dirus_tenant_resolver", async () => {
    const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await app.connect();
    try {
      // Live re-assertion of 1.4's catalog check, run from the app role's
      // own connection.
      const result = await app.query<{ member: string; inherit_option: boolean }>(`
        SELECT m.rolname AS member, am.inherit_option
        FROM pg_auth_members am
        JOIN pg_roles r ON r.oid = am.roleid
        JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = 'dirus_tenant_resolver'
      `);
      const inheriting = result.rows.filter((row) => row.inherit_option);
      expect(inheriting).toEqual([]);
      expect(result.rows.some((row) => row.member === "dirus_app")).toBe(false);
    } finally {
      await app.end();
    }
  });

  it("suspended broker still resolves (product decision P5: no status predicate)", async () => {
    const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await app.connect();
    try {
      const result = await app.query<{ dirus_resolve_broker_id: string | null }>(
        "SELECT dirus_resolve_broker_id('phoneS')",
      );
      expect(result.rows[0].dirus_resolve_broker_id).toBe(brokerSuspendedId);
    } finally {
      await app.end();
    }
  });

  it("search_path hijack: a caller-created temp relation named brokers cannot shadow public.brokers inside the function body", async () => {
    const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
    await app.connect();
    try {
      // Implicitly first-searched (pg_temp_N is prepended to search_path),
      // but this table is empty and has no wa_phone_number_id column at all
      // — if the function's unqualified reference were ever hijackable, this
      // query would error (no such column) instead of returning the real
      // answer.
      await app.query("CREATE TEMP TABLE brokers (id uuid)");
      const result = await app.query<{ dirus_resolve_broker_id: string | null }>(
        "SELECT dirus_resolve_broker_id('phoneA')",
      );
      expect(result.rows[0].dirus_resolve_broker_id).toBe(brokerAId);
    } finally {
      await app.query("DROP TABLE IF EXISTS pg_temp.brokers");
      await app.end();
    }
  });

  it("catalog: search_path is pinned to an empty value in pg_proc.proconfig", async () => {
    const result = await admin.query<{ proconfig: string[] | null }>(
      "SELECT proconfig FROM pg_proc WHERE proname = 'dirus_resolve_broker_id'",
    );
    expect(result.rows[0].proconfig).not.toBeNull();
    expect(result.rows[0].proconfig).toContain("search_path=");
  });

  it("catalog: function is SECURITY DEFINER, owned by dirus_tenant_resolver, returns a scalar uuid", async () => {
    const result = await admin.query<{ prosecdef: boolean; owner: string; rettype: string }>(`
      SELECT p.prosecdef, r.rolname AS owner, t.typname AS rettype
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
      JOIN pg_type t ON t.oid = p.prorettype
      WHERE p.proname = 'dirus_resolve_broker_id'
    `);
    expect(result.rows[0].prosecdef).toBe(true);
    expect(result.rows[0].owner).toBe("dirus_tenant_resolver");
    expect(result.rows[0].rettype).toBe("uuid");
  });

  it("catalog: EXECUTE is revoked from PUBLIC and granted only to dirus_app", async () => {
    const publicHas = await admin.query<{ has: boolean }>(
      "SELECT has_function_privilege('public', 'dirus_resolve_broker_id(text)', 'EXECUTE') AS has",
    );
    expect(publicHas.rows[0].has).toBe(false);
    const appHas = await admin.query<{ has: boolean }>(
      "SELECT has_function_privilege('dirus_app', 'dirus_resolve_broker_id(text)', 'EXECUTE') AS has",
    );
    expect(appHas.rows[0].has).toBe(true);
  });

  it("catalog: the permissive lookup policy's TO clause names only dirus_tenant_resolver", async () => {
    const result = await admin.query<{ roles: string }>(
      `SELECT array_to_string(roles, ',') AS roles FROM pg_policies WHERE tablename = 'brokers' AND policyname = 'tenant_resolver_lookup'`,
    );
    expect(result.rows[0].roles).toBe("dirus_tenant_resolver");
  });

  it("catalog: tenant_isolation on brokers is unchanged (still present, no TO restriction, plus exactly one additional policy)", async () => {
    const result = await admin.query<{ policyname: string; roles: string }>(
      `SELECT policyname, array_to_string(roles, ',') AS roles FROM pg_policies WHERE tablename = 'brokers' ORDER BY policyname`,
    );
    expect(result.rows).toHaveLength(2);
    const isolation = result.rows.find((row) => row.policyname === "tenant_isolation");
    expect(isolation?.roles).toBe("{public}");
  });

  it("MUTATION (negative control does discriminate): dropping the TO clause reopens brokers to dirus_app, confirming the negative control is not vacuous", async () => {
    await admin.query("DROP POLICY tenant_resolver_lookup ON public.brokers");
    await admin.query("CREATE POLICY tenant_resolver_lookup ON public.brokers FOR SELECT USING (true)");
    try {
      const app = new Client({ connectionString: rewriteUser(liveUrl!, "dirus_app", APP_PASSWORD) });
      await app.connect();
      try {
        // Under this mutation, assertion 2 above ("negative control") would
        // fail — this proves that assertion is not vacuously true. No call
        // to dirus_resolve_broker_id is even needed here: with the TO
        // clause gone, tenant_resolver_lookup is permissive to every role,
        // OR-combined with tenant_isolation, so a plain SELECT already leaks.
        const count = await app.query("SELECT count(*) FROM brokers");
        expect(Number(count.rows[0].count)).toBeGreaterThan(0);
      } finally {
        await app.end();
      }
    } finally {
      await admin.query("DROP POLICY tenant_resolver_lookup ON public.brokers");
      await admin.query(
        "CREATE POLICY tenant_resolver_lookup ON public.brokers FOR SELECT TO dirus_tenant_resolver USING (true)",
      );
    }
  });

  it("MUTATION (membership guard does discriminate): an inheriting membership of dirus_app in dirus_tenant_resolver is caught", async () => {
    await admin.query("GRANT dirus_tenant_resolver TO dirus_app");
    try {
      const result = await admin.query<{ member: string; inherit_option: boolean }>(`
        SELECT m.rolname AS member, am.inherit_option
        FROM pg_auth_members am
        JOIN pg_roles r ON r.oid = am.roleid
        JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = 'dirus_tenant_resolver' AND m.rolname = 'dirus_app'
      `);
      // Default GRANT ... TO is inheritable — this is the exact regression
      // the data-model spec scenario "A future regression introducing an
      // inheriting membership is caught by the catalog guard" describes.
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].inherit_option).toBe(true);
    } finally {
      await admin.query("REVOKE dirus_tenant_resolver FROM dirus_app");
    }
  });
});
