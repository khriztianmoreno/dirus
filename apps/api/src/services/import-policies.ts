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
