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
 * Judgment Day round 1 (scaffold-monorepo Phase 4): `0003_app_role_grants.sql`
 * auto-grants `dirus_app` full CRUD on every future table via
 * `ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES`, but nothing about that
 * grant is contingent on the table also being RLS-protected. A future
 * migration that adds a `broker_id`-carrying table and forgets the
 * `ENABLE`/`FORCE`/`CREATE POLICY` block from `0002_rls_policies.sql` ships
 * with silent cross-tenant read/write access: the grant is automatic, the
 * protection is manual. That asymmetry fails OPEN, the worst property for
 * multi-tenant isolation code.
 *
 * This test is the compensating control. It does NOT hardcode which tables
 * must be protected — `rls-policies.test.ts` already hardcodes today's nine
 * `broker_id` tables against the migration's own SQL text, which only
 * catches a regression in a table this repo already knows about. This test
 * instead asks the live Postgres catalog which tables in `public` actually
 * carry a `broker_id` column (plus `brokers`, keyed on `id`) and asserts
 * EVERY one of them is actually tenant-isolated.
 *
 * Guard scope (intentionally not generalized further): this file only ever
 * infers tenancy from a `broker_id` column (or the `brokers` table itself,
 * keyed on `id`) within the single schema it is pointed at — as of round 4
 * that is this suite's own per-run throwaway schema (see
 * `throwaway-schema.ts`), not `public`. A tenant table that scoped tenancy
 * through some other column name would not be discovered. That is a
 * deliberate, documented limitation of this guard's discovery step, not
 * something round 2 changes.
 *
 * Judgment Day round 2: the discovery step above (which tables exist) was
 * never in question. What round 2 found is that the *verification* step —
 * how each discovered table's policy was checked — was pattern matching on
 * policy SQL text (`qual.includes("app.broker_id")`), not behavior. Two
 * independent bypasses were demonstrated against a live container while the
 * old guard reported GREEN:
 *
 *   - Bypass A (decorative predicate): `USING (true OR broker_id = ...)`
 *     contains the substring `app.broker_id` in both `USING` and
 *     `WITH CHECK`, so the string check passed, even though the predicate is
 *     logically always-true and leaks every row to every tenant.
 *   - Bypass B (extra permissive policy): Postgres OR-combines multiple
 *     PERMISSIVE policies on the same table. A table with the correct
 *     `tenant_isolation` policy PLUS an unrelated `FOR ALL USING (true)`
 *     policy (e.g. added later by an ops/support migration) is fully open,
 *     while `.some()` over `pg_policies` still finds the correct policy and
 *     reports GREEN.
 *
 * The fix replaces string matching with a behavioral probe: for every
 * catalog-discovered table, seed real rows for two distinct brokers via the
 * `dirus_app`-shaped application role (mirroring `live-rls-verification.test.ts`'s
 * established pattern), then assert broker A's session can read ONLY broker
 * A's rows and cannot INSERT a row carrying broker B's `broker_id`. An
 * `OR true` predicate or an extra permissive policy fails this probe
 * regardless of how the policy SQL is worded — behavior does not care how
 * the SQL is written.
 *
 * Seeding is catalog-derived, not hand-maintained: `introspectTable()` reads
 * `information_schema.columns`/`information_schema.key_column_usage` for
 * each discovered table to find NOT NULL-no-default columns and their FK
 * targets, and generates values by SQL data type. A table whose seeding
 * requirements this cannot satisfy (an unsupported column type, or a
 * required FK pointing outside the discovered tenant-table set) is reported
 * as **unverifiable** and fails the suite explicitly — it is never silently
 * counted as verified.
 *
 * Known, accepted limitation of the write-side probe: `FORCE ROW LEVEL
 * SECURITY` with a policy that only ever grants `SELECT` (no INSERT-
 * permitting policy at all) denies ALL inserts outright, including a
 * same-tenant "friendly" insert. That is safe (fails closed) but is NOT the
 * same property as "cross-tenant inserts are specifically rejected" — the
 * probe cannot tell those two apart from the outside, so when the friendly
 * insert itself is rejected it reports `inconclusive-write-denied-outright`
 * rather than papering over the distinction as either a pass or a
 * violation.
 *
 * Debt, explicitly deferred (not round 2 scope): this file and
 * `live-rls-verification.test.ts` still duplicate their fixture-role-name /
 * `dropRoles` conventions rather than sharing a helper. That duplication was
 * raised by a judge as theoretical rather than empirically demonstrated, so
 * it remains documented debt rather than a round 2 change.
 *
 * Judgment Day round 6 (CRITICAL, both judges): round 5 had also removed the
 * session-level advisory lock the two files used to coordinate on, reasoning
 * that their fixture role names (`catalog_guard_*` vs `phase4_*`) are
 * disjoint and each file's destructive work lives in its own randomly-named
 * throwaway schema — no shared resource left to protect. That reasoning
 * missed a shared resource round 5 itself introduced in the same commit:
 * `sweepOrphanedThrowawaySchemas`, which swept every `rls_probe_*` schema
 * with no age/session/PID scoping and could drop a sibling suite's
 * still-in-use schema out from under it. Round 6 removed that sweep entirely
 * (see `throwaway-schema.ts`) instead of restoring the lock — with the sweep
 * gone, there is again no shared destructive resource between the two files,
 * and the disjoint-role-name/own-schema reasoning above holds.
 *
 * Judgment Day round 3 (CRITICAL, both judges): the behavioral probe above
 * runs as a synthetic role (`catalog_guard_app`) that is NOT, and never
 * connected as, the real production role `dirus_app` (the role named in
 * `migrations/0003_app_role_grants.sql` / `scripts/provision-app-role.sql`).
 * `CREATE POLICY ... TO <role>` only applies to a session that satisfies
 * `pg_has_role()` for that literal role name, so a policy scoped
 * `TO dirus_app` was invisible to every probe here — both judges
 * demonstrated this live with `CREATE POLICY prod_backdoor ON policies
 * FOR ALL TO dirus_app USING (true) WITH CHECK (true)`, observed as a full
 * cross-tenant leak when connected as `dirus_app`, but reported GREEN by
 * this guard. Two independent, complementary fixes:
 *
 *   (a) Fidelity: `catalog_guard_app` is granted membership in a role
 *       literally named `dirus_app` (created here if it doesn't already
 *       exist; never touches a pre-existing role's login/password). Role
 *       membership is exactly what `pg_has_role()` checks, so this makes
 *       the existing behavioral probes above see a `TO dirus_app` policy
 *       the same way `dirus_app` itself would — proven empirically against
 *       a live container (a member sees the backdoor; a non-member does
 *       not).
 *   (b) Structural backstop: `assertNoUnexpectedRoleScopedPolicies` reads
 *       `pg_policies.roles` directly and fails loud if any discovered
 *       table carries a policy scoped to a role this guard cannot vouch
 *       for (i.e. not `public`, `catalog_guard_app`, or `dirus_app`). This
 *       catches the class even for a role neither (a) nor probing as
 *       `dirus_app` would ever anticipate.
 *
 * (a) alone already turns bypass C below from a false GREEN into a real
 * read/write leak (caught by the existing behavioral assertions); (b) is
 * the generalized backstop for an arbitrary, unanticipated role scope
 * (bypass D below).
 *
 * Judgment Day round 4 (simplification, not another patch): fix (a) above
 * — creating a role literally named `dirus_app`, granting membership into
 * it, and conditionally dropping it — was itself the round 4 finding. That
 * logic could drop a real, pre-existing `dirus_app` role (roles are
 * cluster-global, not scoped to the throwaway database) whenever a
 * `beforeAll` failure left the "did we create it" flag in its default
 * `false` state, and it opened a live `GRANT dirus_app TO catalog_guard_app`
 * privilege-escalation window. Round 4 removes fix (a) entirely: this file
 * never creates, grants into, alters, or drops any role whose name could
 * collide with a real deployed role. Fix (b), the structural backstop, is
 * kept and generalized — `assertNoUnexpectedRoleScopedPolicies`'s
 * allow-list no longer special-cases `dirus_app`, so a policy scoped to
 * `dirus_app` (or any other role this guard cannot vouch for) fails the
 * structural check the same way any other unvouched role does. This suite
 * can no longer *behaviorally* observe a `TO dirus_app` leak the way round
 * 3's fix (a) could — that tradeoff is accepted and documented in
 * `openspec/changes/scaffold-monorepo/apply-progress.md` ("Bypass E") rather
 * than patched around. Round 4 also moves every destructive step in this
 * file (migrations, seeded fixtures, dropped tables) into a per-run,
 * randomly-named schema instead of `public` — see `throwaway-schema.ts` —
 * and guards `afterAll`'s teardown behind a `safeToMutate` flag that only
 * becomes true once `assertThrowawayDatabase` and schema creation have both
 * succeeded, so a refused run can never run a destructive statement.
 */
const liveUrl = process.env.LIVE_TEST_DATABASE_URL;

function readMigration(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}

const OWNER_ROLE = "catalog_guard_owner";
const OWNER_PASSWORD = "catalog-guard-owner-pass";
const APP_ROLE = "catalog_guard_app";
const APP_PASSWORD = "catalog-guard-app-pass";

const BROKER_A = "31111111-1111-1111-1111-111111111111";
const BROKER_B = "32222222-2222-2222-2222-222222222222";

/**
 * Judgment Day round 5 (CRITICAL): drops this suite's own fixture roles.
 * Previously used `DROP OWNED BY` to clear anything the role owned before
 * dropping it — but `DROP OWNED BY` is NOT schema-scoped; Postgres has no
 * `IN SCHEMA` variant. It drops every object that role owns anywhere in the
 * current database, including `public`. A judge demonstrated this live: a
 * role named `catalog_guard_owner` that happened to also own an unrelated
 * `public.leftover_real_table` had that table silently destroyed by this
 * function, even though the table was never touched by anything else in
 * this suite.
 *
 * The fix relies on callers having already dropped this run's own throwaway
 * schema (via `dropThrowawaySchema`) before calling this function — that removes everything the fixture roles could
 * legitimately own. `DROP ROLE` is then attempted directly, with no
 * `DROP OWNED BY` fallback: if a role still owns something outside this
 * suite's blast radius, `DROP ROLE` fails on its own (Postgres refuses to
 * drop a role with dependent objects), and this function reports that
 * loudly and leaves the role in place rather than escalating to an
 * unscoped drop. A leftover role from a crashed run is a nuisance; silently
 * destroying a developer's unrelated objects is data loss.
 */
async function dropRoles(admin: Client): Promise<void> {
  for (const role of [APP_ROLE, OWNER_ROLE]) {
    try {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    } catch (err) {
      console.warn(
        `[rls-catalog-guard] could not drop role "${role}": it still owns objects outside ` +
          `this suite's throwaway schema(s). Leaving the role in place rather than running an ` +
          `unscoped "DROP OWNED BY", which would destroy those objects wherever they live. ` +
          `Inspect and clean up manually if needed. Original error: ${(err as Error).message}`,
      );
    }
  }
}

/** Rebuilds a connection string with a different user/password, same host/db. */
function rewriteUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

/**
 * Catalog-derived, not hand-maintained: enumerates every base table in
 * `schema` that carries a `broker_id` column, plus `brokers` itself (keyed
 * on `id`, the tenant root). This is what makes the guard catch a table
 * this file's author never saw. (Guard scope: single schema and
 * `broker_id`-naming only — see file header.)
 */
async function discoverTenantTables(admin: Client, schema: string): Promise<string[]> {
  const result = await admin.query<{ table_name: string }>(
    `
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
      AND c.relkind = 'r'
      AND (
        c.relname = 'brokers'
        OR EXISTS (
          SELECT 1
          FROM information_schema.columns col
          WHERE col.table_schema = $1
            AND col.table_name = c.relname
            AND col.column_name = 'broker_id'
        )
      )
    ORDER BY c.relname
  `,
    [schema],
  );
  return result.rows.map((row) => row.table_name);
}

/**
 * Judgment Day round 3, fix (b), generalized in round 4: reads
 * `pg_policies.roles` directly (not the probe's behavior) and fails loud if
 * any of `tables` carries a policy scoped to a role this guard cannot vouch
 * for. `allowedRoles` should be exactly the roles the behavioral probe above
 * is proven to cover (`public` and the probe role itself) — any other role
 * name, including `dirus_app`, means the probe's GREEN result cannot be
 * trusted for that table. Round 4 removed the round-3 membership trick that
 * special-cased `dirus_app` into this allow-list; see file header.
 */
async function assertNoUnexpectedRoleScopedPolicies(
  admin: Client,
  tables: string[],
  allowedRoles: string[],
  schema: string,
): Promise<void> {
  // `roles` is `name[]`; the pg driver has no built-in parser for that array
  // OID, so it comes back as a raw string ("{public}") rather than a JS
  // array. array_to_string sidesteps that entirely.
  const result = await admin.query<{ tablename: string; policyname: string; roles: string }>(
    `SELECT tablename, policyname, array_to_string(roles, ',') AS roles
     FROM pg_policies WHERE schemaname = $2 AND tablename = ANY($1::text[])`,
    [tables, schema],
  );
  const allowed = new Set(allowedRoles);
  const violations = result.rows
    .map((row) => ({ ...row, roleList: row.roles.split(",") }))
    .filter((row) => !row.roleList.every((role) => allowed.has(role)));
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `${v.tablename}.${v.policyname} -> [${v.roleList.join(", ")}]`)
      .join("; ");
    throw new Error(
      `policy scoped to a role this guard cannot vouch for — a "TO <role>" clause only ` +
        `applies to sessions that satisfy pg_has_role() for that role, so this guard's ` +
        `behavioral probe cannot be trusted for it: ${detail}`,
    );
  }
}

class UnverifiableTableError extends Error {
  constructor(
    public table: string,
    reason: string,
  ) {
    super(`table "${table}" cannot be generically verified: ${reason}`);
  }
}

interface TableSchema {
  /** NOT NULL, no-default columns that need an explicit seed value (excludes "id" and "broker_id", which are handled specially). */
  columns: { name: string; dataType: string }[];
  /** Every single-column FK on this table (column -> referenced table), used both for seeding order and dependency lookups. */
  fks: Map<string, string>;
}

async function introspectTable(admin: Client, table: string, schema: string): Promise<TableSchema> {
  const colsResult = await admin.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $2 AND table_name = $1
     ORDER BY ordinal_position`,
    [table, schema],
  );

  const fksResult = await admin.query<{ column_name: string; referenced_table: string }>(
    `SELECT kcu.column_name, ccu.table_name AS referenced_table
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $2 AND tc.table_name = $1`,
    [table, schema],
  );

  const fks = new Map<string, string>();
  for (const row of fksResult.rows) {
    fks.set(row.column_name, row.referenced_table);
  }

  const columns = colsResult.rows
    .filter(
      (row) => row.column_name !== "id" && row.column_name !== "broker_id" && row.is_nullable === "NO" && row.column_default === null,
    )
    .map((row) => ({ name: row.column_name, dataType: row.data_type }));

  return { columns, fks };
}

/** Topologically orders `tables` by their FK edges (within the given set only) so dependencies seed first. */
function topoSort(tables: string[], fksByTable: Map<string, Map<string, string>>): string[] {
  const deps = new Map<string, Set<string>>();
  for (const table of tables) {
    const edges = new Set<string>();
    for (const ref of fksByTable.get(table)!.values()) {
      if (tables.includes(ref) && ref !== table) {
        edges.add(ref);
      }
    }
    deps.set(table, edges);
  }

  const sorted: string[] = [];
  const visited = new Set<string>();

  function visit(table: string, stack: Set<string>): void {
    if (visited.has(table)) return;
    if (stack.has(table)) {
      throw new Error(`FK cycle detected among tenant tables involving "${table}"`);
    }
    stack.add(table);
    for (const dep of deps.get(table)!) {
      visit(dep, stack);
    }
    stack.delete(table);
    visited.add(table);
    sorted.push(table);
  }

  for (const table of tables) {
    visit(table, new Set());
  }
  return sorted;
}

// Monotonic counter so generated `date` values are unique per call (some
// tables, e.g. renewals, have a UNIQUE(fk_column, date_column) constraint —
// a constant date would collide across seed calls and masquerade as an RLS
// write rejection).
let dateCounter = 0;

/** Generates a value for a NOT NULL, no-default, non-FK column by SQL data type. Only the types actually present in the schema today are supported; anything else makes the table unverifiable rather than silently seeding garbage. */
function genericValue(table: string, column: string, dataType: string, seedTag: string): string {
  switch (dataType) {
    case "uuid":
      return randomUUID();
    case "text":
    case "character varying":
    case "character":
      return `probe-${table}-${column}-${seedTag}`;
    case "jsonb":
    case "json":
      return "{}";
    case "date": {
      dateCounter += 1;
      const day = String((dateCounter % 27) + 1).padStart(2, "0");
      const month = String(((Math.floor(dateCounter / 27) % 11) + 1)).padStart(2, "0");
      return `2027-${month}-${day}`;
    }
    default:
      throw new UnverifiableTableError(
        table,
        `column "${column}" has unsupported type "${dataType}" for generic seeding`,
      );
  }
}

async function insertGraphRow(
  owner: Client,
  table: string,
  brokerId: string,
  rowId: string,
  schema: TableSchema,
  seededIds: Map<string, string>,
  seedTag: string,
): Promise<void> {
  const columnNames: string[] = [];
  const values: unknown[] = [];

  if (table === "brokers") {
    columnNames.push("id");
    values.push(rowId);
  } else {
    columnNames.push("id", "broker_id");
    values.push(rowId, brokerId);
  }

  for (const col of schema.columns) {
    const refTable = schema.fks.get(col.name);
    if (refTable) {
      const refId = seededIds.get(refTable);
      if (!refId) {
        throw new UnverifiableTableError(
          table,
          `NOT NULL FK column "${col.name}" references "${refTable}", which was not seeded before "${table}" (topological order issue, or "${refTable}" is outside the discovered tenant-table set)`,
        );
      }
      columnNames.push(col.name);
      values.push(refId);
    } else {
      columnNames.push(col.name);
      values.push(genericValue(table, col.name, col.dataType, seedTag));
    }
  }

  const placeholders = columnNames.map((_, i) => `$${i + 1}`).join(", ");
  const quotedCols = columnNames.map((c) => `"${c}"`).join(", ");
  await owner.query(`INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders})`, values);
}

/** Seeds one row per table (in `order`) for `brokerId`, as the owner role, inside a single transaction scoped via `set_config('app.broker_id', ...)` — an own-tenant insert, so this respects (does not bypass) each table's real RLS policy. Returns table -> seeded row id. */
async function seedTenantGraph(
  owner: Client,
  brokerId: string,
  order: string[],
  schemas: Map<string, TableSchema>,
  seedTag: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  await owner.query("BEGIN");
  try {
    await owner.query("SELECT set_config('app.broker_id', $1, true)", [brokerId]);
    for (const table of order) {
      const rowId = table === "brokers" ? brokerId : randomUUID();
      await insertGraphRow(owner, table, brokerId, rowId, schemas.get(table)!, ids, seedTag);
      ids.set(table, rowId);
    }
    await owner.query("COMMIT");
  } catch (err) {
    await owner.query("ROLLBACK");
    throw err;
  }
  return ids;
}

/** Deletes seeded graph rows (superuser `admin` connection, bypasses RLS) in reverse dependency order. */
async function cleanupGraph(admin: Client, order: string[], graphs: Map<string, string>[]): Promise<void> {
  const reverseOrder = [...order].reverse();
  for (const table of reverseOrder) {
    const ids = graphs.map((graph) => graph.get(table)).filter((id): id is string => Boolean(id));
    if (ids.length > 0) {
      await admin.query(`DELETE FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
    }
  }
}

/** Behavioral read-side probe: as the app role scoped to `ownBrokerId`, does the query surface the other broker's seeded row? */
async function checkReadIsolation(
  app: Client,
  table: string,
  ownBrokerId: string,
  ownRowId: string,
  otherRowId: string,
): Promise<"isolated" | "leaked"> {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.broker_id', $1, true)", [ownBrokerId]);
    const result = await app.query<{ id: string }>(`SELECT id FROM "${table}" WHERE id = ANY($1::uuid[])`, [
      [ownRowId, otherRowId],
    ]);
    const seenIds = new Set(result.rows.map((row) => row.id));
    if (!seenIds.has(ownRowId)) {
      throw new Error(
        `probe malfunction on "${table}": broker-scoped session could not see its own seeded row — cannot trust this result`,
      );
    }
    return seenIds.has(otherRowId) ? "leaked" : "isolated";
  } finally {
    await app.query("ROLLBACK");
  }
}

type WriteProbeStatus = "isolated" | "leaked" | "inconclusive-write-denied-outright";

/** Behavioral write-side probe for `broker_id`-carrying tables: attempts a same-tenant insert, then a cross-tenant insert (broker_id swapped, same dependency rows). See file header for the "denied outright" caveat. */
async function checkWriteIsolation(
  app: Client,
  table: string,
  schema: TableSchema,
  ownGraph: Map<string, string>,
  ownBrokerId: string,
  otherBrokerId: string,
): Promise<WriteProbeStatus> {
  const buildRow = (brokerId: string): { columnNames: string[]; values: unknown[] } => {
    const rowId = randomUUID();
    const columnNames = ["id", "broker_id"];
    const values: unknown[] = [rowId, brokerId];
    for (const col of schema.columns) {
      const refTable = schema.fks.get(col.name);
      if (refTable) {
        const refId = ownGraph.get(refTable);
        if (!refId) {
          throw new UnverifiableTableError(
            table,
            `write probe: missing seeded dependency "${refTable}" for column "${col.name}"`,
          );
        }
        columnNames.push(col.name);
        values.push(refId);
      } else {
        columnNames.push(col.name);
        values.push(genericValue(table, col.name, col.dataType, `write-${rowId.slice(0, 8)}`));
      }
    }
    return { columnNames, values };
  };

  const attemptInsert = async (brokerId: string): Promise<boolean> => {
    const { columnNames, values } = buildRow(brokerId);
    const placeholders = columnNames.map((_, i) => `$${i + 1}`).join(", ");
    const quotedCols = columnNames.map((c) => `"${c}"`).join(", ");
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.broker_id', $1, true)", [ownBrokerId]);
    try {
      await app.query(`INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders})`, values);
      return true;
    } catch {
      return false;
    } finally {
      await app.query("ROLLBACK");
    }
  };

  const friendlyOk = await attemptInsert(ownBrokerId);
  if (!friendlyOk) {
    // Cannot distinguish "denied because cross-tenant" from "denied
    // because this table denies ALL writes" (e.g. FORCE + SELECT-only
    // policy). Both are safe (fail closed); only the first is proof of
    // tenant isolation. Say so explicitly rather than guessing.
    return "inconclusive-write-denied-outright";
  }
  const crossOk = await attemptInsert(otherBrokerId);
  return crossOk ? "leaked" : "isolated";
}

/**
 * `brokers` is keyed on `id` (the tenant id itself), not `broker_id`, so the
 * INSERT-based cross-tenant probe above doesn't apply cleanly (inserting a
 * row with `id = otherBrokerId` collides with that broker's own already-
 * seeded PK regardless of RLS). Use an UPDATE-based probe instead: same
 * "friendly write succeeds, cross-tenant write is rejected" shape, applied
 * to a column update instead of an insert.
 */
async function checkBrokersWriteIsolation(app: Client, ownBrokerId: string, otherBrokerId: string): Promise<WriteProbeStatus> {
  await app.query("BEGIN");
  let friendlyOk: boolean;
  try {
    await app.query("SELECT set_config('app.broker_id', $1, true)", [ownBrokerId]);
    const res = await app.query("UPDATE brokers SET plan = plan WHERE id = $1", [ownBrokerId]);
    friendlyOk = (res.rowCount ?? 0) > 0;
  } catch {
    friendlyOk = false;
  }

  let crossAffected = 0;
  if (friendlyOk) {
    const res = await app.query("UPDATE brokers SET plan = 'hacked' WHERE id = $1", [otherBrokerId]);
    crossAffected = res.rowCount ?? 0;
  }
  await app.query("ROLLBACK");

  if (!friendlyOk) {
    return "inconclusive-write-denied-outright";
  }
  return crossAffected > 0 ? "leaked" : "isolated";
}

interface VerificationResult {
  table: string;
  readStatus: "isolated" | "leaked";
  writeStatus: WriteProbeStatus;
}

async function verifyTenantIsolation(
  app: Client,
  table: string,
  schema: TableSchema,
  graphA: Map<string, string>,
  graphB: Map<string, string>,
): Promise<VerificationResult> {
  const ownRowIdA = graphA.get(table)!;
  const otherRowIdB = graphB.get(table)!;
  const readStatus = await checkReadIsolation(app, table, BROKER_A, ownRowIdA, otherRowIdB);
  const writeStatus =
    table === "brokers"
      ? await checkBrokersWriteIsolation(app, BROKER_A, BROKER_B)
      : await checkWriteIsolation(app, table, schema, graphA, BROKER_A, BROKER_B);
  return { table, readStatus, writeStatus };
}

/** Seeds a minimal fixture (`table` plus its listed dependencies) and runs the behavioral probe against just that one table — used by the RED bypass demonstrations below, which only need to break one table's policy. */
async function verifySingleTable(
  admin: Client,
  owner: Client,
  app: Client,
  table: string,
  deps: string[],
  schema: string,
): Promise<VerificationResult> {
  const tables = [...new Set([...deps, table])];
  const schemas = new Map<string, TableSchema>();
  for (const t of tables) {
    schemas.set(t, await introspectTable(admin, t, schema));
  }
  const fksByTable = new Map(tables.map((t) => [t, schemas.get(t)!.fks]));
  const order = topoSort(tables, fksByTable);

  const graphA = await seedTenantGraph(owner, BROKER_A, order, schemas, "bypass-a");
  const graphB = await seedTenantGraph(owner, BROKER_B, order, schemas, "bypass-b");
  try {
    return await verifyTenantIsolation(app, table, schemas.get(table)!, graphA, graphB);
  } finally {
    await cleanupGraph(admin, order, [graphA, graphB]);
  }
}

describe.skipIf(!liveUrl)("catalog-derived RLS guard (Judgment Day round 2 — behavioral probe)", () => {
  let admin: Client;
  let owner: Client;
  let app: Client;
  let schema: string;
  // Judgment Day round 4 (CRITICAL): set true only after the throwaway
  // checks below succeed and this suite's own throwaway schema exists.
  // `afterAll` must not run any destructive statement until then, so a
  // refused run (wrong database, or schema creation itself failing) can
  // never destroy anything.
  let safeToMutate = false;

  beforeAll(async () => {
    admin = new Client({ connectionString: liveUrl });
    await admin.connect();

    // Judgment Day round 3 (WARNING): refuse to run any of the destructive
    // steps below unless the target is provably a throwaway database. See
    // assert-throwaway-database.ts.
    await assertThrowawayDatabase(admin);

    // Judgment Day round 6 (CRITICAL): round 5 added a sweep here for
    // `rls_probe_*` schemas orphaned by a crashed prior run (hard kill skips
    // `afterAll`). It was removed: with no age/session/PID scoping, it could
    // not tell an orphan apart from `live-rls-verification.test.ts`'s
    // currently-in-use schema when the two run concurrently, and Vitest runs
    // test files in parallel by default. A judge reproduced the resulting
    // "schema ... does not exist" race live. See `throwaway-schema.ts` for
    // the full reasoning. Orphaned schemas from a crashed run are now
    // documented debt — clean up manually with
    // `DROP SCHEMA rls_probe_* CASCADE` if they accumulate locally.

    // Clean up a possibly-crashed prior local run's roles before creating
    // fresh ones (idempotent local re-runs). This suite's own fixture roles
    // (`catalog_guard_owner`/`catalog_guard_app`) and `live-rls-verification
    // .test.ts`'s (`phase4_owner`/`phase4_app`) are disjoint names, so there
    // is no cross-file role-creation race to guard against here — no
    // advisory lock needed. `dropRoles` never touches `public` or a role it
    // didn't create itself here; see its docstring.
    await dropRoles(admin);

    schema = randomThrowawaySchemaName();
    await createThrowawaySchema(admin, schema);
    // Judgment Day round 4: from here on, this run owns both its roles and
    // its schema, so teardown is safe.
    safeToMutate = true;
    await admin.query(`SET search_path TO "${schema}"`);

    await admin.query(`CREATE ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CREATE, USAGE ON SCHEMA "${schema}" TO ${OWNER_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${APP_ROLE}`);
    // Applies to every future connection made as these roles, so per-`Client`
    // `SET search_path` calls aren't needed anywhere else in this file.
    await admin.query(`ALTER ROLE ${OWNER_ROLE} SET search_path TO "${schema}"`);
    await admin.query(`ALTER ROLE ${APP_ROLE} SET search_path TO "${schema}"`);

    const migrator = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, OWNER_PASSWORD) });
    await migrator.connect();
    try {
      await migrator.query(rewriteSchemaQualification(readMigration("0000_init.sql"), schema));
      await migrator.query(rewriteSchemaQualification(readMigration("0002_rls_policies.sql"), schema));
    } finally {
      await migrator.end();
    }

    // Least-privilege app-role grants (mirrors 0003_app_role_grants.sql's
    // shape), so the behavioral probe runs as the application actually
    // would, not as the migration-owning role.
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}`);

    owner = new Client({ connectionString: rewriteUser(liveUrl!, OWNER_ROLE, OWNER_PASSWORD) });
    await owner.connect();
    app = new Client({ connectionString: rewriteUser(liveUrl!, APP_ROLE, APP_PASSWORD) });
    await app.connect();
  });

  afterAll(async () => {
    // Judgment Day round 3 (SUGGESTION), still true in round 4: if
    // `beforeAll` threw before `admin` was assigned, there is nothing to
    // clean up.
    if (!admin) return;

    // Issue 3 (Judgment Day round 2, WARNING): if any step here throws,
    // admin.end() below must still run — otherwise a long-lived
    // `vitest --watch` process keeps the connection open forever.
    try {
      // Judgment Day round 4 (CRITICAL): the exact scenario a judge
      // demonstrated live — `beforeAll` refuses (assertThrowawayDatabase
      // throws) and `afterAll` ran anyway, dropping real tables. Nothing
      // below this line may run unless `safeToMutate` is true.
      if (safeToMutate) {
        await owner?.end();
        await app?.end();
        // Judgment Day round 5: drop this run's own throwaway schema FIRST
        // — that removes everything the fixture roles legitimately own —
        // then attempt to drop the roles. See `dropRoles`'s docstring for
        // why no `DROP OWNED BY` fallback exists here.
        await dropThrowawaySchema(admin, schema);
        await dropRoles(admin);
      }
    } finally {
      await admin.end();
    }
  });

  it("discovers a non-empty set of tenant tables (the guard is not vacuous)", async () => {
    const tables = await discoverTenantTables(admin, schema);
    expect(tables.length).toBeGreaterThan(0);
  });

  it("RED: catches bypass A — a decorative 'true OR ...' predicate passes string matching but leaks", async () => {
    await admin.query(`DROP POLICY tenant_isolation ON policies`);
    await admin.query(`
      CREATE POLICY tenant_isolation ON policies FOR ALL
        USING      (true OR broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
        WITH CHECK (true OR broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
    `);
    try {
      const result = await verifySingleTable(admin, owner, app, "policies", ["brokers", "contacts"], schema);
      // A string-matching guard (`qual.includes("app.broker_id")`) would
      // have reported this table protected — both clauses contain the
      // substring. The predicate is logically always-true, so the
      // behavioral probe must see the leak on both read and write.
      expect(result.readStatus).toBe("leaked");
      expect(result.writeStatus).toBe("leaked");
    } finally {
      await admin.query(`DROP POLICY tenant_isolation ON policies`);
      await admin.query(`
        CREATE POLICY tenant_isolation ON policies FOR ALL
          USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
          WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
      `);
    }
  });

  it("RED: catches bypass B — a correct policy plus an extra permissive FOR ALL USING (true) policy leaks via OR-combination", async () => {
    await admin.query(`CREATE POLICY support_backdoor ON policies FOR ALL USING (true)`);
    try {
      const result = await verifySingleTable(admin, owner, app, "policies", ["brokers", "contacts"], schema);
      // Postgres OR-combines multiple PERMISSIVE policies; `.some()` over
      // `pg_policies` would still find `tenant_isolation` and report GREEN.
      // The behavioral probe sees the actual (open) result of the OR.
      expect(result.readStatus).toBe("leaked");
      expect(result.writeStatus).toBe("leaked");
    } finally {
      await admin.query(`DROP POLICY support_backdoor ON policies`);
    }
  });

  it("RED (Judgment Day round 4, replaces the former bypass C/D pair): a policy scoped to a role this guard cannot vouch for — including one that used to be the production role `dirus_app` — is invisible to behavioral probing but caught structurally by pg_policies.roles", async () => {
    // Round 3's fix (a) made the probe role-equivalent to a role literally
    // named `dirus_app` (CREATE ROLE + GRANT membership) specifically so it
    // could observe a `TO dirus_app` policy leak behaviorally. Round 4
    // removed that trick: this suite must never create, grant into, or drop
    // any role whose name could collide with a real deployed role, so it
    // can no longer authenticate as (or as a member of) a role literally
    // named `dirus_app`, and CREATE POLICY ... TO <role> requires the role
    // to already exist. `catalog_guard_prod_role_stand_in` below stands in
    // for that case without ever touching the real name — the point being
    // proven is that the structural backstop is role-name-agnostic, so
    // `dirus_app` needs no special case at all.
    // Judgment Day round 5 (SUGGESTION): idempotent. A same-named role
    // surviving a crashed prior run (the paired `DROP ROLE` in `finally`
    // below never ran) would otherwise make this `CREATE ROLE` throw before
    // entering the `try`, so the crash-recovery path itself would crash.
    await admin.query(`DROP ROLE IF EXISTS catalog_guard_prod_role_stand_in`);
    await admin.query(`CREATE ROLE catalog_guard_prod_role_stand_in NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await admin.query(
        `CREATE POLICY prod_backdoor ON policies FOR ALL TO catalog_guard_prod_role_stand_in USING (true) WITH CHECK (true)`,
      );
      try {
        // The behavioral probe alone does NOT see this: APP_ROLE has no
        // membership in this role, so pg_has_role() is false and the
        // backdoor policy never applies to its session — the exact
        // invisibility both judges demonstrated for `TO dirus_app` in round
        // 3, now handled without ever granting membership into anything.
        const result = await verifySingleTable(admin, owner, app, "policies", ["brokers", "contacts"], schema);
        expect(result.readStatus).toBe("isolated");
        expect(result.writeStatus).toBe("isolated");

        // The structural assertion reads pg_policies.roles directly,
        // independent of which role the probe happens to authenticate as —
        // this is what actually catches it now, for `dirus_app` and any
        // other unvouched role alike.
        await expect(
          assertNoUnexpectedRoleScopedPolicies(admin, ["policies"], ["public", APP_ROLE], schema),
        ).rejects.toThrow(/catalog_guard_prod_role_stand_in/);
      } finally {
        await admin.query(`DROP POLICY prod_backdoor ON policies`);
      }
    } finally {
      await admin.query(`DROP ROLE catalog_guard_prod_role_stand_in`);
    }
  });

  it("GREEN: protects every catalog-discovered table via behavioral read+write probes, not string matching", async () => {
    const tables = await discoverTenantTables(admin, schema);

    // Judgment Day round 3, fix (b), generalized in round 4: structural
    // backstop, independent of which role the behavioral probe below
    // authenticates as. `dirus_app` is deliberately NOT in this allow-list —
    // see file header.
    await assertNoUnexpectedRoleScopedPolicies(admin, tables, ["public", APP_ROLE], schema);

    const schemas = new Map<string, TableSchema>();
    for (const table of tables) {
      schemas.set(table, await introspectTable(admin, table, schema));
    }
    const fksByTable = new Map(tables.map((table) => [table, schemas.get(table)!.fks]));
    const order = topoSort(tables, fksByTable);

    const graphA = await seedTenantGraph(owner, BROKER_A, order, schemas, "green-a");
    const graphB = await seedTenantGraph(owner, BROKER_B, order, schemas, "green-b");

    const leaks: string[] = [];
    const unverifiable: string[] = [];
    const writeDeniedOutright: string[] = [];

    try {
      for (const table of tables) {
        try {
          const result = await verifyTenantIsolation(app, table, schemas.get(table)!, graphA, graphB);
          if (result.readStatus === "leaked" || result.writeStatus === "leaked") {
            leaks.push(`${table} (read=${result.readStatus}, write=${result.writeStatus})`);
          }
          if (result.writeStatus === "inconclusive-write-denied-outright") {
            writeDeniedOutright.push(table);
          }
        } catch (err) {
          if (err instanceof UnverifiableTableError) {
            unverifiable.push(err.message);
          } else {
            throw err;
          }
        }
      }
    } finally {
      await cleanupGraph(admin, order, [graphA, graphB]);
    }

    if (writeDeniedOutright.length > 0) {
      // Not a failure: see file header. Surfaced for visibility rather than
      // silently folded into either a pass or a violation.
      console.warn(
        `[rls-catalog-guard] write probe inconclusive (denies ALL writes, not just cross-tenant ones) for: ${writeDeniedOutright.join(", ")}`,
      );
    }

    // A table this guard could not verify must never be counted as
    // verified — fail loud and name it, same as an actual leak.
    expect(unverifiable).toEqual([]);
    expect(leaks).toEqual([]);
  });
});
