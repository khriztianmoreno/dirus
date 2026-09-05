import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseImportFile } from "../../src/services/import-policies.js";

/**
 * Phase 5 tasks 5.1-5.3 (proposal P7/O4). `parseImportFile` is the real
 * CSV/XLSX-to-typed-row parser Phase 4's `ImportGuardFile.text`'s docstring
 * explicitly deferred here — NOT `runImportGuards`'s guard-only line
 * splitter, which stays exactly what it is (a header/row-count counter,
 * CSV-only, never producing the per-field row objects the per-row loop
 * validates and upserts).
 *
 * Library choice (task 5.1): `papaparse` for CSV, `xlsx` (SheetJS) for
 * XLSX — both plain dependencies of `apps/api` (proposal P7): not
 * `packages/schemas` (zod-only by rule) and not `packages/integrations`
 * (third-party *service* clients, not file-format libraries).
 *
 * Both formats must parse to an EQUIVALENT row shape: `{ header: string[];
 * rows: Record<string, string>[] }`, keyed by the camelCase column names
 * `policyImportRowSchema` (Phase 2) expects directly — no column-mapping
 * layer (proposal Out of Scope).
 */
describe("parseImportFile", () => {
  it("5.2 parses a CSV file into header + row objects", () => {
    const csv = ["insurer,line,endDate,phone", "Sura,auto,2027-01-01,+573000000001"].join("\n");

    const result = parseImportFile({ filename: "policies.csv", buffer: Buffer.from(csv, "utf8") });

    expect(result.header).toEqual(["insurer", "line", "endDate", "phone"]);
    expect(result.rows).toEqual([
      { insurer: "Sura", line: "auto", endDate: "2027-01-01", phone: "+573000000001" },
    ]);
  });

  it("5.2 parses an equivalent XLSX file into the same row shape as the CSV fixture", () => {
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["insurer", "line", "endDate", "phone"],
      ["Sura", "auto", "2027-01-01", "+573000000001"],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const result = parseImportFile({ filename: "policies.xlsx", buffer });

    expect(result.header).toEqual(["insurer", "line", "endDate", "phone"]);
    expect(result.rows).toEqual([
      { insurer: "Sura", line: "auto", endDate: "2027-01-01", phone: "+573000000001" },
    ]);
  });

  it("5.2 triangulation: a multi-row CSV parses every data row in source order", () => {
    const csv = [
      "insurer,line,endDate,phone",
      "Sura,auto,2027-01-01,+573000000001",
      "Bolivar,vida,2027-06-15,+573000000002",
    ].join("\n");

    const result = parseImportFile({ filename: "policies.csv", buffer: Buffer.from(csv, "utf8") });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toEqual({
      insurer: "Bolivar",
      line: "vida",
      endDate: "2027-06-15",
      phone: "+573000000002",
    });
  });

  it("5.2 rejects a filename with an unsupported extension", () => {
    expect(() => parseImportFile({ filename: "policies.txt", buffer: Buffer.from("x") })).toThrow(/csv|xlsx/i);
  });
});
