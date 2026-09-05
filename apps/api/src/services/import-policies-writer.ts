import { and, eq, sql } from "drizzle-orm";
import { schema, withBrokerContext, type TenantDb } from "@dirus/db";
import { policyImportRowSchema, type PolicyImportRow } from "@dirus/schemas";
import type { ParsedRow } from "./import-policies.js";

/**
 * The per-row Zod-validate + write loop (tasks 5.4-5.24), split out of
 * `import-policies.ts` on purpose — see that file's own docstring on why
 * `@dirus/db` (which throws at import time without `DATABASE_URL`) must
 * never appear in the same module as `runImportGuards`/`parseImportFile`.
 */

/**
 * Proposal P5's stated consequence, surfaced verbatim in the row's
 * `warnings` array (spec "Rows Without policy_number Are Honestly
 * Non-Idempotent") — a row with no `policy_number` inserts every time it
 * is imported, including on re-import of the identical file.
 */
export const NON_IDEMPOTENT_ROW_WARNING =
  "no policy_number: this row is not idempotent and will duplicate on re-import";

export type ImportRowFieldError = { field: string; message: string };

export type ImportRowSuccess = {
  row: number;
  status: "inserted" | "updated";
  policyId: string;
  contactId: string;
  warnings?: string[];
};

export type ImportRowFailure = {
  row: number;
  status: "failed";
  errors: ImportRowFieldError[];
};

export type ImportRowResult = ImportRowSuccess | ImportRowFailure;

export type ImportPoliciesResult = {
  brokerId: string;
  totals: { rows: number; inserted: number; updated: number; failed: number };
  rows: ImportRowResult[];
};

/**
 * proposal Round 2 O5 (resolved: fail-the-row), spec scenario "A row whose
 * policy_number matches but whose phone maps to a different contact fails
 * the row". Thrown INSIDE the per-row `tx.transaction(...)` savepoint
 * (task 5.24) so the mismatch check's own read is rolled back cleanly
 * without touching any other row's work in the outer transaction.
 */
class RowImportError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = "RowImportError";
  }
}

// Derived from `policyImportRowSchema.safeParse`'s own return type rather
// than importing `zod` directly — `apps/api` does not depend on `zod`
// (only `@dirus/schemas` does), and this avoids adding a redundant direct
// dependency for one error-shape type.
type RowParseResult = ReturnType<typeof policyImportRowSchema.safeParse>;
type RowParseFailure = Extract<RowParseResult, { success: false }>;

function zodErrorToFieldErrors(error: RowParseFailure["error"]): ImportRowFieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(row)",
    message: issue.message,
  }));
}

/**
 * A blank spreadsheet cell parses (task 5.1-5.3) as an empty string, not an
 * absent key — CSV/XLSX have no concept of "undefined", only "empty cell".
 * `policyImportRowSchema`'s optional fields (Phase 2) are `.optional()` at
 * the KEY level (`min(2).optional()`, etc.), which does not itself accept
 * an empty STRING as a valid "not provided" value — `"".trim().min(2)`
 * still fails. Normalizing every empty-string cell to `undefined` before
 * validation is what makes an optional field's blank cell behave as "not
 * provided" (spec "A blank spreadsheet field does not erase existing
 * contact data") rather than as a validation failure. Required fields
 * (`phone`, `insurer`, `line`, `endDate`) still fail loudly on a blank
 * cell — `undefined` for a required field is exactly what Zod's own
 * "required" error is for.
 */
function normalizeBlankCells(row: ParsedRow): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = value === "" ? undefined : value;
  }
  return normalized;
}

/**
 * The contact find-or-create half of each row (spec "Contact Find-or-Create
 * Fills Blanks Only"), task 5.10's fill-blanks-only `COALESCE` upsert.
 *
 * P4 (non-negotiable): `consent_at` appears in NEITHER the insert column
 * list NOR the `DO UPDATE SET` column list, ever — there is no
 * `row.consent`/`row.acepta_terminos` field on `PolicyImportRow` to begin
 * with (Phase 2's schema never parses one), so this statement has no
 * `consentAt` value to write even if a source file's header row carried
 * such a column. See `import-policies.live.test.ts`'s dedicated adversarial
 * consent test for the query-level assertion.
 */
async function upsertContact(tx: TenantDb, brokerId: string, row: PolicyImportRow): Promise<string> {
  const [contactRow] = await tx
    .insert(schema.contacts)
    .values({
      brokerId,
      phone: row.phone,
      fullName: row.fullName ?? null,
      docType: row.docType ?? null,
      docNumber: row.docNumber ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.contacts.brokerId, schema.contacts.phone],
      // Fill-blanks-only (task 5.10): the EXISTING column comes first in
      // each COALESCE, so a non-null existing value always wins over the
      // spreadsheet's value — whether the spreadsheet value is blank OR
      // simply different (spec "A differing spreadsheet field does not
      // overwrite existing contact data").
      set: {
        fullName: sql`coalesce(${schema.contacts.fullName}, excluded.full_name)`,
        docType: sql`coalesce(${schema.contacts.docType}, excluded.doc_type)`,
        docNumber: sql`coalesce(${schema.contacts.docNumber}, excluded.doc_number)`,
      },
    })
    .returning({ id: schema.contacts.id });

  return contactRow.id;
}

/**
 * The `policies` half of each row: idempotent upsert keyed on
 * `(broker_id, policy_number)` when the row has one (spec "Idempotent
 * Policy Upsert...", task 5.16), or an unconditional insert when it does
 * not (spec "Rows Without policy_number Are Honestly Non-Idempotent", task
 * 5.21). The policy_number/contact mismatch check (task 5.18) runs BEFORE
 * either statement, in application code — there is no unique constraint on
 * `contact_id` alone for the database to reject a mismatch with.
 */
async function upsertPolicy(
  tx: TenantDb,
  brokerId: string,
  contactId: string,
  row: PolicyImportRow,
): Promise<{ policyId: string; status: "inserted" | "updated"; warnings?: string[] }> {
  const values = {
    brokerId,
    contactId,
    insurer: row.insurer,
    line: row.line,
    policyNumber: row.policyNumber ?? null,
    plate: row.plate ?? null,
    premiumAmount: row.premiumAmount ?? null,
    commissionPct: row.commissionPct ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate,
    // `policies.currency` is NOT NULL with a DB-level default of 'COP'
    // that only applies when the column is omitted entirely on INSERT —
    // an UPDATE's `.set()` must supply a concrete value, never `undefined`
    // or `null`. `copCurrencySchema` only ever accepts the literal "COP",
    // so defaulting an absent value to "COP" here is equivalent to the
    // column's own default, not a behavior change.
    currency: row.currency ?? "COP",
  };

  if (!row.policyNumber) {
    // task 5.21: unconditional INSERT, never routed through the
    // ON CONFLICT path — an unnumbered row is never matched against an
    // existing one (spec "Rows Without policy_number Are Honestly
    // Non-Idempotent").
    const [inserted] = await tx.insert(schema.policies).values(values).returning({ id: schema.policies.id });
    return { policyId: inserted.id, status: "inserted", warnings: [NON_IDEMPOTENT_ROW_WARNING] };
  }

  // task 5.18: the mismatch check MUST run before the upsert statement.
  const [existingPolicy] = await tx
    .select({ id: schema.policies.id, contactId: schema.policies.contactId })
    .from(schema.policies)
    .where(and(eq(schema.policies.brokerId, brokerId), eq(schema.policies.policyNumber, row.policyNumber)))
    .limit(1);

  if (existingPolicy && existingPolicy.contactId !== contactId) {
    throw new RowImportError(
      "policyNumber",
      `policy_number "${row.policyNumber}" belongs to a different contact`,
    );
  }

  const [upserted] = await tx
    .insert(schema.policies)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.policies.brokerId, schema.policies.policyNumber],
      // Phase 1's unique index on (broker_id, policy_number) is PARTIAL
      // (`WHERE policy_number IS NOT NULL`) — Postgres only accepts a
      // partial index as an ON CONFLICT arbiter when the INSERT statement
      // repeats that same predicate; without it Postgres reports "no
      // unique or exclusion constraint matching the ON CONFLICT
      // specification" (42P10), since a plain `target` alone can only
      // match a full unique index. This branch is reached only when
      // `row.policyNumber` is truthy (see the `if (!row.policyNumber)`
      // branch above), so the predicate always holds here.
      targetWhere: sql`${schema.policies.policyNumber} is not null`,
      // Full overwrite, NOT fill-blanks-only (spec: "update the matching
      // row's fields otherwise") — unlike the contact upsert above, a
      // re-imported policy row's values are the new source of truth for
      // its own row. Every field the row carries is applied verbatim.
      set: {
        insurer: values.insurer,
        line: values.line,
        plate: values.plate,
        premiumAmount: values.premiumAmount,
        currency: values.currency,
        commissionPct: values.commissionPct,
        startDate: values.startDate,
        endDate: values.endDate,
      },
    })
    .returning({ id: schema.policies.id });

  return { policyId: upserted.id, status: existingPolicy ? "updated" : "inserted" };
}

/**
 * One row's full write path (contact find-or-create -> mismatch check ->
 * policy upsert/insert), run inside its OWN `tx.transaction(...)` savepoint
 * (task 5.24) so a failure anywhere in this row's statements rolls back
 * only this row's writes, never poisoning the outer `withBrokerContext`
 * transaction another row's work is running inside.
 */
async function processRow(tx: TenantDb, brokerId: string, row: PolicyImportRow): Promise<ImportRowSuccess> {
  const contactId = await upsertContact(tx, brokerId, row);
  const { policyId, status, warnings } = await upsertPolicy(tx, brokerId, contactId, row);
  return { row: -1, status, policyId, contactId, ...(warnings ? { warnings } : {}) };
}

/**
 * The per-row loop (task 5.5): Zod-validates each parsed row independently
 * and, on success, runs `processRow` inside a nested `tx.transaction(...)`
 * savepoint. A validation failure OR a `processRow` rejection is caught
 * into a per-row `"failed"` result — it never throws out of the loop (spec
 * "Row Validation Is Per-Row, Not Whole-File", "One malformed row does not
 * fail the file").
 *
 * task 5.24 — transaction nesting, not reentrancy: this is the ONE
 * `withBrokerContext(brokerId, ...)` call for the whole file import.
 * `tx.transaction(...)` below opens a SAVEPOINT on the SAME already-open
 * broker-scoped transaction `tx` — never a second `withBrokerContext`
 * call, which `packages/db/src/tenant.ts`'s reentrancy guard would throw
 * on. `tx.transaction`'s callback rejecting rolls back only that
 * savepoint; the outer transaction (and every other row's already-
 * committed-to-the-outer-transaction work) is unaffected and the loop
 * continues to the next row.
 */
export async function importPolicyRows(brokerId: string, rows: ParsedRow[]): Promise<ImportPoliciesResult> {
  return withBrokerContext(brokerId, async (tx) => {
    const results: ImportRowResult[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 1;
      const parsed = policyImportRowSchema.safeParse(normalizeBlankCells(rows[index]));

      if (!parsed.success) {
        results.push({ row: rowNumber, status: "failed", errors: zodErrorToFieldErrors(parsed.error) });
        continue;
      }

      try {
        const rowResult = await tx.transaction((rowTx) => processRow(rowTx, brokerId, parsed.data));
        results.push({ ...rowResult, row: rowNumber });
      } catch (error) {
        if (error instanceof RowImportError) {
          results.push({ row: rowNumber, status: "failed", errors: [{ field: error.field, message: error.message }] });
          continue;
        }
        // An unexpected (non-`RowImportError`) failure is a real bug, not
        // a per-row validation outcome — it is not swallowed into a
        // "failed" row result, matching this codebase's fail-loud stance
        // elsewhere (e.g. tenant-resolver.ts never guesses on ambiguity).
        throw error;
      }
    }

    const totals = results.reduce(
      (acc, result) => {
        acc.rows += 1;
        acc[result.status] += 1;
        return acc;
      },
      { rows: 0, inserted: 0, updated: 0, failed: 0 },
    );

    return { brokerId, totals, rows: results };
  });
}
