import { describe, expect, it } from "vitest";
import { extractedField, extractionEnvelope } from "../src/extraction-envelope.js";

/**
 * `admin-dashboard` (C1) task 5.1, design.md D-E's exact shape:
 * `Record<field, { value: unknown; confidence: number }>`, `@provisional`
 * pending B2 (`ingestion-agent`). This is SHAPE validation only — no
 * producer of this merged shape exists yet (`extractions.output`/
 * `.confidence` are two separate columns; `toEnvelope`, tasks 5.3-5.5, is
 * the one place that zips them into this shape). Written against the
 * not-yet-written schema (RED).
 */
describe("extractionEnvelope (design.md D-E, task 5.1, @provisional)", () => {
  it("parses a well-formed Record<field, { value, confidence }> object", () => {
    const result = extractionEnvelope.safeParse({
      policyNumber: { value: "POL-123", confidence: 0.92 },
      endDate: { value: "2027-01-01", confidence: 0.61 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policyNumber).toEqual({ value: "POL-123", confidence: 0.92 });
      expect(result.data.endDate).toEqual({ value: "2027-01-01", confidence: 0.61 });
    }
  });

  it("rejects a confidence value outside [0, 1]", () => {
    const tooHigh = extractedField.safeParse({ value: "x", confidence: 1.5 });
    const tooLow = extractedField.safeParse({ value: "x", confidence: -0.1 });
    expect(tooHigh.success).toBe(false);
    expect(tooLow.success).toBe(false);
  });

  it("accepts any shape for value: unknown — string, number, object, null", () => {
    expect(extractedField.safeParse({ value: "a string", confidence: 0.5 }).success).toBe(true);
    expect(extractedField.safeParse({ value: 42, confidence: 0.5 }).success).toBe(true);
    expect(extractedField.safeParse({ value: { nested: true }, confidence: 0.5 }).success).toBe(true);
    expect(extractedField.safeParse({ value: null, confidence: 0.5 }).success).toBe(true);
  });

  it("rejects a field entry missing confidence entirely", () => {
    const result = extractedField.safeParse({ value: "x" });
    expect(result.success).toBe(false);
  });
});
