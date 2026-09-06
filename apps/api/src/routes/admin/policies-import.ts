import type { Context, Hono } from "hono";
import type { AppVariables } from "../../app.js";
import { createAdminAuthMiddleware } from "../../middleware/admin-auth.js";
import {
  MAX_IMPORT_FILE_SIZE_BYTES,
  parseImportFile,
  runImportGuards,
  type ParsedRow,
  type ResolveBrokerExists,
} from "../../services/import-policies.js";
import type { ImportPoliciesResult } from "../../services/import-policies-writer.js";

/**
 * Phase 6 (proposal Approach, spec "Response Reports Per-Row Outcome and
 * File-Level Totals") — pure composition. This route wires Phase 3's
 * admin-auth middleware, Phase 4's file-level guards, and Phase 5's per-row
 * import service together. It contains no auth, guard, or upsert logic of
 * its own — see each piece's own file/tests for that.
 *
 * `importPolicyRows` is injected here, never imported as a VALUE from
 * `import-policies-writer.ts` (which pulls in `@dirus/db`, and `@dirus/db`
 * throws at import time without `DATABASE_URL`) — mirrors `app.ts`'s
 * `createApp({ ingest, ... })` convention exactly, so this route stays
 * offline-testable with fakes. Only `apps/api/src/index.ts` (task 6.4)
 * wires in the real writer function and the real `brokerExists` lookup.
 * The `ImportPoliciesResult` import above is TYPE-ONLY — erased at compile
 * time, so it never reaches this module's runtime import graph.
 */
export type ImportPolicyRowsFn = (
  brokerId: string,
  rows: ParsedRow[],
) => Promise<ImportPoliciesResult>;

export type AdminPoliciesImportRouteOptions = {
  /** Phase 3's provisional shared-bearer-token secret (`env.ADMIN_API_TOKEN`). */
  adminToken: string;
  /** Phase 4's injected broker-existence check — never a direct `@dirus/db` import here. */
  resolveBrokerExists: ResolveBrokerExists;
  /** Phase 5's per-row write loop — injected for the same offline-testability reason. */
  importPolicyRows: ImportPolicyRowsFn;
};

type RouteContext = Context<{ Variables: AppVariables }>;

/**
 * Builds a minimal CSV-shaped text body from an already-parsed header and a
 * data-row count, purely so Phase 4's CSV-only `runImportGuards`
 * (`splitCsvLines`, a guard-only line counter — see that file's own
 * docstring) can run its header-name and row-count checks against BOTH
 * source formats without any change to Phase 4's code. `runImportGuards`
 * never inspects row CELL VALUES — only the header row's column names and
 * the data-row COUNT — so the reconstructed body below carries no real cell
 * content, only one blank line per data row.
 */
function toGuardCsvText(header: string[], dataRowCount: number): string {
  return [header.join(","), ...Array.from({ length: dataRowCount }, () => "")].join("\n");
}

/**
 * `POST /admin/policies/import`. Order, per proposal Approach and spec
 * "Response Reports Per-Row Outcome and File-Level Totals":
 *
 *   1. Admin-token middleware (Phase 3) — 401 short-circuits before any
 *      multipart parsing at all.
 *   2. Read `brokerId`/`file` from the multipart body.
 *   3. A missing file is delegated to `runImportGuards` (Phase 4) for a
 *      consistent "file is required" message/status — a real `File` is
 *      needed to measure/parse it, so this is checked here rather than
 *      inside the guard function itself, but the wording comes from Phase 4.
 *   4. Raw byte-size check BEFORE any parsing (spec "A file exceeding the
 *      size limit is rejected before parsing", "no row is parsed") —
 *      checked directly against the uploaded file's byte length; on
 *      rejection, `parseImportFile` below never runs.
 *   5. `parseImportFile` (Phase 5) — the real per-format CSV/XLSX parse,
 *      producing the header/rows both formats need. A parse failure (e.g.
 *      an unsupported extension) is its own file-level 4xx (spec:
 *      "unparseable file").
 *   6. `runImportGuards` (Phase 4) — brokerId presence, row-count limit,
 *      broker existence, required-header check, fed a guard-only CSV-shaped
 *      text built from step 5's already-parsed header/rows (see
 *      `toGuardCsvText`).
 *   7. `importPolicyRows` (Phase 5) — the per-row write loop. Its own return
 *      shape already matches the proposal's response sketch verbatim, so
 *      the handler passes it straight through as the 200 response body.
 *
 * Task 6.3: every rejection above (steps 1, 3, 4, 5, 6) is a 4xx (401 from
 * step 1; 400/404 from the rest). Step 7 is reached ONLY once the file
 * itself is authorized and well-formed — from that point on the handler
 * unconditionally returns 200, whatever the per-row totals turn out to be.
 * No code path after step 7 inspects `result.totals.failed` to change the
 * status code.
 */
export function registerAdminPoliciesImportRoute(
  app: Hono<{ Variables: AppVariables }>,
  { adminToken, resolveBrokerExists, importPolicyRows }: AdminPoliciesImportRouteOptions,
): void {
  const authMiddleware = createAdminAuthMiddleware(adminToken);

  async function handleImport(c: RouteContext) {
    const body = await c.req.parseBody();

    const brokerIdField = body["brokerId"];
    const brokerId =
      typeof brokerIdField === "string" && brokerIdField.length > 0 ? brokerIdField : undefined;

    const fileField = body["file"];
    const uploadedFile = fileField instanceof File ? fileField : undefined;

    if (!uploadedFile) {
      const guardResult = await runImportGuards({ brokerId, file: undefined }, { resolveBrokerExists });
      if (guardResult.ok) {
        // Unreachable: runImportGuards rejects any request with no file.
        // Fail loud rather than silently proceeding without one, matching
        // this codebase's stance elsewhere (e.g. import-policies-writer.ts
        // rethrows unexpected errors rather than absorbing them).
        throw new Error("unexpected: runImportGuards accepted a request with no file");
      }
      return c.json({ error: guardResult.error }, guardResult.status);
    }

    const buffer = Buffer.from(await uploadedFile.arrayBuffer());
    const sizeBytes = buffer.length;

    if (sizeBytes > MAX_IMPORT_FILE_SIZE_BYTES) {
      // Step 4: rejected on raw byte size alone — `parseImportFile` below
      // never runs for an oversized file (spec "no row is parsed").
      const guardResult = await runImportGuards(
        { brokerId, file: { sizeBytes, text: "" } },
        { resolveBrokerExists },
      );
      if (guardResult.ok) {
        // Unreachable: runImportGuards checks size before it ever reads
        // `file.text`, so an oversized file can never reach `ok: true`.
        throw new Error("unexpected: runImportGuards accepted an oversized file");
      }
      return c.json({ error: guardResult.error }, guardResult.status);
    }

    let parsed: { header: string[]; rows: ParsedRow[] };
    try {
      parsed = parseImportFile({ filename: uploadedFile.name, buffer });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "unable to parse file" }, 400);
    }

    const guardResult = await runImportGuards(
      { brokerId, file: { sizeBytes, text: toGuardCsvText(parsed.header, parsed.rows.length) } },
      { resolveBrokerExists },
    );

    if (!guardResult.ok) {
      return c.json({ error: guardResult.error }, guardResult.status);
    }

    const result = await importPolicyRows(guardResult.brokerId, parsed.rows);
    return c.json(result, 200);
  }

  app.post("/admin/policies/import", authMiddleware, handleImport);
}
