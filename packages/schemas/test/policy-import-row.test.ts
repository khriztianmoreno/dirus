import { describe, expect, it } from "vitest";
import { policyImportRowSchema } from "../src/policy-import-row.js";

/**
 * policy-bulk-import (A1), proposal O1 (NEEDS CONFIRMATION) / spec "Row
 * Validation Is Per-Row, Not Whole-File": the required set is exactly the
 * schema's own NOT-NULL columns — `insurer`, `line`, `endDate`, and a
 * contact `phone`. Everything else is optional on presence pending a real
 * broker spreadsheet.
 */
const validRow = {
  insurer: "Seguros Bolívar",
  line: "auto",
  endDate: "2027-01-15",
  phone: "+573001234567",
};

describe("policyImportRowSchema (spreadsheet row -> policies + contacts upsert)", () => {
  it("parses a row containing only the required fields", () => {
    const result = policyImportRowSchema.safeParse(validRow);
    expect(result.success).toBe(true);
  });

  it("parses a row with every recognized field present", () => {
    const result = policyImportRowSchema.safeParse({
      ...validRow,
      policyNumber: "AUT-004521873",
      plate: "ABC123",
      premiumAmount: "1250000.00",
      currency: "COP",
      commissionPct: "12.50",
      startDate: "2026-01-15",
      fullName: "Juan Carlos Pérez Gómez",
      docType: "CC",
      docNumber: "1032456789",
    });
    expect(result.success).toBe(true);
  });

  describe("required fields — missing any one fails naming that field", () => {
    it.each(["insurer", "line", "endDate", "phone"] as const)(
      "rejects a row missing %s",
      (missingField) => {
        const row: Record<string, unknown> = { ...validRow };
        delete row[missingField];

        const result = policyImportRowSchema.safeParse(row);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((issue) => issue.path.includes(missingField))).toBe(
            true,
          );
        }
      },
    );
  });

  describe("every other recognized column is optional on presence", () => {
    it("validates a required-only row without policyNumber, plate, premiumAmount, currency, commissionPct, startDate, fullName, docType or docNumber", () => {
      const result = policyImportRowSchema.safeParse(validRow);
      expect(result.success).toBe(true);
    });

    it("does not reject explicit undefined for every optional column", () => {
      const result = policyImportRowSchema.safeParse({
        ...validRow,
        policyNumber: undefined,
        plate: undefined,
        premiumAmount: undefined,
        currency: undefined,
        commissionPct: undefined,
        startDate: undefined,
        fullName: undefined,
        docType: undefined,
        docNumber: undefined,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("strict on shape", () => {
    it("rejects an invalid endDate naming the field", () => {
      const result = policyImportRowSchema.safeParse({ ...validRow, endDate: "not-a-date" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes("endDate"))).toBe(true);
      }
    });

    it("rejects an impossible calendar endDate", () => {
      const result = policyImportRowSchema.safeParse({ ...validRow, endDate: "2026-02-30" });
      expect(result.success).toBe(false);
    });

    it("rejects a phone that is not a plausible phone shape, naming the field", () => {
      const result = policyImportRowSchema.safeParse({ ...validRow, phone: "not-a-phone" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes("phone"))).toBe(true);
      }
    });

    it("rejects a phone that is too short to be plausible", () => {
      const result = policyImportRowSchema.safeParse({ ...validRow, phone: "123" });
      expect(result.success).toBe(false);
    });

    it("rejects a line outside the closed enum", () => {
      const result = policyImportRowSchema.safeParse({ ...validRow, line: "moto" });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed plate when present", () => {
      const result = policyImportRowSchema.safeParse({ ...validRow, plate: "AB1234" });
      expect(result.success).toBe(false);
    });

    it("rejects an invalid startDate when present", () => {
      const result = policyImportRowSchema.safeParse({ ...validRow, startDate: "not-a-date" });
      expect(result.success).toBe(false);
    });
  });
});
