import { describe, expect, it, vi } from "vitest";
import { policyImportRowSchema } from "@dirus/schemas";
import {
  MAX_IMPORT_FILE_SIZE_BYTES,
  MAX_IMPORT_ROW_COUNT,
  runImportGuards,
} from "../../src/services/import-policies.js";

/**
 * Phase 4 (proposal Round 2 O2/O3, spec "Multipart Request Shape",
 * "Request Size Is Bounded Before Parsing Begins"). This suite only
 * exercises the file-level guards that run BEFORE any row-level work:
 * `brokerId` presence, file size, row count, broker existence, required
 * headers. Row parsing (CSV/XLSX library, Phase 5, proposal O4) and the
 * per-row Zod/upsert loop (Phase 5) are out of scope here — this file's
 * `buildCsv` fixture helper is a plain, dependency-free stand-in text
 * body, matching `runImportGuards`'s own guard-only line splitter, not the
 * real Phase 5 parser.
 *
 * Entirely offline, mirroring `middleware/tenant-resolver.test.ts`'s
 * injected-fake convention (`resolveBrokerExists` here plays the same role
 * `resolveBrokerId` plays there) — no `@dirus/db` import is reachable from
 * this test's import graph.
 */

const REQUIRED_HEADER_ROW = "insurer,line,endDate,phone";

function buildCsv(rowCount: number): string {
  const rows = Array.from(
    { length: rowCount },
    (_, i) => `Sura,auto,2027-01-0${(i % 9) + 1},+57123456${String(i % 100).padStart(3, "0")}`,
  );
  return [REQUIRED_HEADER_ROW, ...rows].join("\n");
}

const alwaysExists = async () => true;
const neverExists = async () => false;

describe("runImportGuards", () => {
  it("4.1 rejects a request with a file but no brokerId, naming brokerId, before any row is parsed", async () => {
    const result = await runImportGuards(
      { brokerId: undefined, file: { sizeBytes: 10, text: buildCsv(1) } },
      { resolveBrokerExists: alwaysExists },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(result.error).toContain("brokerId");
  });

  it("4.2 rejects a file exceeding 5 MB naming the size limit, before any row-validation spy is ever called", async () => {
    const safeParseSpy = vi.spyOn(policyImportRowSchema, "safeParse");

    const result = await runImportGuards(
      {
        brokerId: "broker-1",
        file: { sizeBytes: MAX_IMPORT_FILE_SIZE_BYTES + 1, text: buildCsv(1) },
      },
      { resolveBrokerExists: alwaysExists },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(result.error).toMatch(/size/i);
    expect(safeParseSpy).not.toHaveBeenCalled();

    safeParseSpy.mockRestore();
  });

  it("4.3 rejects a well-formed file with 5,001 data rows naming the row-count limit, structurally BEFORE any row reaches per-row Zod validation", async () => {
    const safeParseSpy = vi.spyOn(policyImportRowSchema, "safeParse");
    const oversizedCsv = buildCsv(MAX_IMPORT_ROW_COUNT + 1);

    const result = await runImportGuards(
      { brokerId: "broker-1", file: { sizeBytes: oversizedCsv.length, text: oversizedCsv } },
      { resolveBrokerExists: alwaysExists },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(result.error).toMatch(/row/i);

    // The point of this test: the count-then-reject step is structurally
    // separate from the per-row loop, proven by spying on the actual
    // schema Phase 5's per-row loop will call for validation — asserting
    // ZERO invocations, not merely that the response is eventually a 4xx.
    expect(safeParseSpy).not.toHaveBeenCalled();

    safeParseSpy.mockRestore();
  });

  it("4.5 rejects an unknown brokerId with 404, and logs a structured line containing ONLY brokerId", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runImportGuards(
      { brokerId: "unknown-broker", file: { sizeBytes: 10, text: buildCsv(1) } },
      { resolveBrokerExists: neverExists },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.status).toBe(404);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("policy_import_unknown_broker", { brokerId: "unknown-broker" });

    // Negative assertion, mirroring tenant-resolver.test.ts's convention:
    // the single logged call carries no file content or row data.
    const loggedArgs = logSpy.mock.calls[0];
    const loggedText = loggedArgs.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    expect(loggedText).not.toMatch(/Sura|auto|2027|\+57/);

    logSpy.mockRestore();
  });

  it("4.7 rejects a file missing a required header (endDate) wholesale, naming it, with no rows returned", async () => {
    const csvMissingEndDate = ["insurer,line,phone", "Sura,auto,+571234567"].join("\n");

    const result = await runImportGuards(
      { brokerId: "broker-1", file: { sizeBytes: csvMissingEndDate.length, text: csvMissingEndDate } },
      { resolveBrokerExists: alwaysExists },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(result.error).toContain("endDate");
  });

  it("passes a well-formed request with all required headers present, returning the parsed header and data rows", async () => {
    const csv = buildCsv(2);

    const result = await runImportGuards(
      { brokerId: "broker-1", file: { sizeBytes: csv.length, text: csv } },
      { resolveBrokerExists: alwaysExists },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.brokerId).toBe("broker-1");
    expect(result.header).toEqual(["insurer", "line", "endDate", "phone"]);
    expect(result.dataRows).toHaveLength(2);
  });
});
