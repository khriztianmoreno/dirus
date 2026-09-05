import Papa from "papaparse";
import * as XLSX from "xlsx";
import { policyImportRowSchema } from "@dirus/schemas";

/**
 * Proposal Round 2 O2 (resolved): 5 MB file size / 5,000 data-row caps,
 * both enforced before any row is parsed. A guard at the top of the
 * handler, not baked into the schema or the migration, so raising either
 * limit later touches one place. No real broker file exists to calibrate
 * against — this is a conservative starting limit chosen to keep a
 * synchronous request inside a typical platform HTTP timeout.
 */
export const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROW_COUNT = 5000;

/**
 * Phase 2's row schema (`packages/schemas/src/policy-import-row.ts`) is the
 * single source of truth for which columns are required — O1's
 * NOT-NULL-derived set (`insurer`, `line`, `endDate`, `phone`). Derived
 * here via each shape entry's own `.isOptional()`, never a hardcoded
 * duplicate list, so if Phase 2's schema and this required-header check
 * ever drift apart, it breaks loudly (a missing export, a type error) —
 * task 4.7-4.8's explicit requirement — rather than silently disagreeing
 * with Phase 2.
 */
const REQUIRED_HEADERS = Object.entries(policyImportRowSchema.shape)
  .filter(([, fieldSchema]) => !fieldSchema.isOptional())
  .map(([key]) => key);

export type ResolveBrokerExists = (brokerId: string) => Promise<boolean>;

export type ImportGuardFile = {
  /** Raw byte size of the uploaded file, checked before any parsing. */
  sizeBytes: number;
  /**
   * Decoded file text. Phase 4 only needs the header row and a row count
   * to run its guards — full CSV/XLSX-to-typed-row parsing is Phase 5's
   * job (proposal P7/O4, tasks 5.1-5.3), which will pick a real parsing
   * library. `splitCsvLines` below is a deliberately minimal, guard-only
   * line splitter: good enough to count rows and read header names, never
   * used to produce the typed rows Phase 5's per-row loop will validate
   * and upsert.
   */
  text: string;
};

export type ImportGuardInput = {
  brokerId: string | undefined;
  file: ImportGuardFile | undefined;
};

export type ImportGuardRejection = {
  ok: false;
  /** 400 for every file-shape/limit/header problem; 404 for an unknown brokerId (proposal Round 2 O3). */
  status: 400 | 404;
  error: string;
};

export type ImportGuardPass = {
  ok: true;
  brokerId: string;
  header: string[];
  dataRows: string[][];
};

export type ImportGuardResult = ImportGuardRejection | ImportGuardPass;

export type RunImportGuardsDeps = {
  /**
   * Design mirrors `middleware/tenant-resolver.ts`'s `ResolveBrokerId`
   * injection convention exactly: never a real `@dirus/db` import here, so
   * this module — and everything that calls it — stays offline-testable
   * with a fake. Only `apps/api/src/index.ts` (Phase 6) wires in a real
   * broker-existence lookup.
   */
  resolveBrokerExists: ResolveBrokerExists;
};

/**
 * Runs every file-level guard from spec "Multipart Request Shape",
 * "Request Size Is Bounded Before Parsing Begins", and the required-header
 * half of "Row Validation Is Per-Row, Not Whole-File" — everything that
 * must reject BEFORE any row reaches per-row Zod validation or the import
 * service (Phase 5). Order:
 *
 *   1. `brokerId` presence (spec "Missing brokerId is rejected...").
 *   2. File size, before any parsing (spec "A file exceeding the size
 *      limit is rejected before parsing", proposal O2).
 *   3. Row count, via the guard-only line count below — structurally
 *      separate from, and never reaching, per-row Zod validation (spec "A
 *      file exceeding the row-count limit is rejected before any row is
 *      upserted"; task 4.3's ordering assertion). This function never
 *      calls `policyImportRowSchema.safeParse` on any row itself.
 *   4. Broker existence (spec "Unknown brokerId is rejected before any
 *      row is processed", proposal Round 2 O3) — a single structured log
 *      line on miss, mirroring `tenant-resolver.ts`'s
 *      `tenant_resolution_miss` pattern exactly, logging ONLY `brokerId`.
 *   5. Required-header check against Phase 2's row schema (spec "A file
 *      missing a required header is rejected wholesale").
 *
 * On success, returns the parsed header and raw data rows for Phase 5's
 * per-row loop to validate and upsert.
 */
export async function runImportGuards(
  input: ImportGuardInput,
  deps: RunImportGuardsDeps,
): Promise<ImportGuardResult> {
  const { brokerId, file } = input;

  if (!brokerId) {
    return { ok: false, status: 400, error: "brokerId is required" };
  }

  if (!file) {
    return { ok: false, status: 400, error: "file is required" };
  }

  if (file.sizeBytes > MAX_IMPORT_FILE_SIZE_BYTES) {
    return {
      ok: false,
      status: 400,
      error: `file exceeds the maximum size of ${MAX_IMPORT_FILE_SIZE_BYTES} bytes`,
    };
  }

  const { header, dataRows } = splitCsvLines(file.text);

  if (dataRows.length > MAX_IMPORT_ROW_COUNT) {
    return {
      ok: false,
      status: 400,
      error: `file exceeds the maximum row count of ${MAX_IMPORT_ROW_COUNT}`,
    };
  }

  const brokerExists = await deps.resolveBrokerExists(brokerId);
  if (!brokerExists) {
    // Proposal Round 2 O3, mirroring tenant-resolver.ts's
    // tenant_resolution_miss pattern exactly: a single structured
    // argument containing ONLY brokerId, never file content or row data.
    console.error("policy_import_unknown_broker", { brokerId });
    return { ok: false, status: 404, error: "broker not found" };
  }

  const missingHeaders = REQUIRED_HEADERS.filter((required) => !header.includes(required));
  if (missingHeaders.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `file is missing required header(s): ${missingHeaders.join(", ")}`,
    };
  }

  return { ok: true, brokerId, header, dataRows };
}

/**
 * Task 5.1's picks: `papaparse` for CSV, `xlsx` (SheetJS) for XLSX — both
 * plain `apps/api` dependencies (proposal P7), no architectural stakes
 * (proposal O4). Dispatched purely by filename extension; no content
 * sniffing, matching this change's fixed-header-contract stance (proposal
 * Out of Scope: "no interactive column mapping").
 */
export type ParsedImportFile = {
  filename: string;
  buffer: Buffer;
};

export type ParsedRow = Record<string, string>;

export type ParsedImportResult = {
  header: string[];
  rows: ParsedRow[];
};

/**
 * Real per-field CSV/XLSX parser (tasks 5.1-5.3), producing the typed row
 * objects `policyImportRowSchema` (Phase 2) validates and the per-row loop
 * upserts. Deliberately separate from `runImportGuards`'s guard-only
 * `splitCsvLines` below, which only ever counts rows and reads header
 * names from decoded text — see that function's own docstring.
 *
 * Both formats produce an EQUIVALENT shape: the header row's cells become
 * object keys, verbatim (no camelCase conversion, no trimming beyond what
 * each library does natively) — the fixed header contract (proposal Out of
 * Scope) already requires the source file's header cells to match
 * `policyImportRowSchema`'s field names exactly.
 */
export function parseImportFile(file: ParsedImportFile): ParsedImportResult {
  const extension = file.filename.split(".").pop()?.toLowerCase();

  if (extension === "csv") {
    return parseCsv(file.buffer);
  }

  if (extension === "xlsx" || extension === "xls") {
    return parseXlsx(file.buffer);
  }

  throw new Error(
    `unsupported import file extension: "${extension ?? file.filename}" — expected .csv or .xlsx`,
  );
}

function parseCsv(buffer: Buffer): ParsedImportResult {
  const text = buffer.toString("utf8");
  const parsed = Papa.parse<ParsedRow>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const header = parsed.meta.fields ?? [];
  return { header, rows: parsed.data };
}

function parseXlsx(buffer: Buffer): ParsedImportResult {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<ParsedRow>(worksheet, { defval: "", raw: false });
  const header = rows.length > 0 ? Object.keys(rows[0]) : (XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0] as string[] | undefined) ?? [];
  return { header, rows };
}

/**
 * Guard-only CSV line splitter (see `ImportGuardFile.text`'s docstring) —
 * NOT the real parser. Splits on newlines and commas, trims whitespace,
 * and treats the first non-empty line as the header. Sufficient for
 * counting rows and reading header names; Phase 5 replaces the data-row
 * body with a real CSV/XLSX library (proposal O4) for actual per-field
 * parsing.
 */
function splitCsvLines(text: string): { header: string[]; dataRows: string[][] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const [headerLine, ...dataLines] = lines;
  const header = (headerLine ?? "").split(",").map((cell) => cell.trim());
  const dataRows = dataLines.map((line) => line.split(",").map((cell) => cell.trim()));
  return { header, dataRows };
}

/**
 * The per-row Zod-validation + DB write loop (tasks 5.4-5.24) lives in
 * `./import-policies-writer.ts`, a SEPARATE module from this file — not a
 * stylistic split. This file (`runImportGuards`, `parseImportFile`) must
 * stay importable with zero `@dirus/db` in its module graph, exactly like
 * `runImportGuards`'s existing docstring promises ("this module — and
 * everything that calls it — stays offline-testable with a fake"):
 * `@dirus/db`'s `internal/client.ts` throws AT IMPORT TIME if
 * `DATABASE_URL` is unset (design.md D-A/D-B's fail-loud guard), which
 * would break every existing offline test in this file's own test suite
 * (`import-policies.test.ts`, `import-policies-parse.test.ts`) the moment
 * a `@dirus/db` import appeared anywhere in this module — even in a
 * function neither test calls. `import-policies-writer.ts` imports
 * `ParsedRow` from here (a plain, dependency-free type) and is the only
 * file in this pair that imports `@dirus/db`.
 */
