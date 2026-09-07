import { describe, expect, it } from "vitest";
import { toEnvelope } from "../../src/services/to-envelope.js";

/**
 * `admin-dashboard` (C1) tasks 5.3-5.4, design.md D-E. `toEnvelope` is the
 * ONE place that zips `extractions.output` (`Record<field, unknown>`) and
 * `extractions.confidence` (`Record<field, number>`) — two independently-
 * typed `jsonb` columns — into the read-side
 * `Record<field, { value, confidence }>` envelope view. `safeParse`, never
 * `parse` (design.md D-E): an unrecognized shape must degrade to a raw-JSON
 * fallback marker, never throw.
 */
describe("toEnvelope (design.md D-E, tasks 5.3-5.5)", () => {
  it("5.3: zips a well-formed output/confidence pair into distinct per-field entries, not one opaque object", () => {
    const output = { policyNumber: "POL-123", endDate: "2027-01-01" };
    const confidence = { policyNumber: 0.92, endDate: 0.61 };

    const result = toEnvelope(output, confidence);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Extraction-review spec "Fields below 0.85 are individually visible":
      // policyNumber and endDate are distinct, separately-addressable
      // entries — never merged into one blob.
      expect(result.fields.policyNumber).toEqual({ value: "POL-123", confidence: 0.92 });
      expect(result.fields.endDate).toEqual({ value: "2027-01-01", confidence: 0.61 });
      expect(Object.keys(result.fields)).toHaveLength(2);
    }
  });

  it("5.4: non-overlapping output/confidence keys degrade to a raw-JSON fallback marker, not a throw", () => {
    const output = { policyNumber: "POL-123" };
    const confidence = { totallyDifferentKey: 0.92 };

    expect(() => toEnvelope(output, confidence)).not.toThrow();
    const result = toEnvelope(output, confidence);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.raw).toEqual({ output, confidence });
    }
  });

  it("5.4: a non-numeric confidence value degrades to a raw-JSON fallback marker, not a throw", () => {
    const output = { policyNumber: "POL-123" };
    const confidence = { policyNumber: "not-a-number" };

    expect(() => toEnvelope(output, confidence)).not.toThrow();
    const result = toEnvelope(output, confidence);
    expect(result.ok).toBe(false);
  });

  it("5.4: output/confidence that are not plain objects at all (array, string, null) degrade to fallback, never throw", () => {
    expect(() => toEnvelope([1, 2, 3], {})).not.toThrow();
    expect(toEnvelope([1, 2, 3], {}).ok).toBe(false);

    expect(() => toEnvelope("not-an-object", {})).not.toThrow();
    expect(toEnvelope("not-an-object", {}).ok).toBe(false);

    expect(() => toEnvelope(null, null)).not.toThrow();
    expect(toEnvelope(null, null).ok).toBe(false);
  });
});
