import { describe, expect, it } from "vitest";
import { caratulaSchema } from "../src/caratula.js";

describe("caratulaSchema (carátula -> policies + policyholder contacts upsert)", () => {
  it("parses a complete, realistic carátula", () => {
    const result = caratulaSchema.safeParse({
      insurer: "Seguros Bolívar",
      line: "auto",
      policyNumber: "AUT-004521873",
      plate: "ABC123",
      premiumAmount: "1250000.00",
      currency: "COP",
      startDate: "2026-01-15",
      endDate: "2027-01-15",
      insuredFullName: "Juan Carlos Pérez Gómez",
      insuredDocNumber: "1032456789",
    });

    expect(result.success).toBe(true);
  });

  it("parses a partial extraction — a blurry photo where only insurer and endDate are legible", () => {
    const result = caratulaSchema.safeParse({
      insurer: "Sura",
      endDate: "2026-12-01",
    });

    expect(result.success).toBe(true);
  });

  it("parses an empty object — every field is optional on presence", () => {
    expect(caratulaSchema.safeParse({}).success).toBe(true);
  });

  it("rejects a malformed plate", () => {
    const result = caratulaSchema.safeParse({ plate: "AB1234" });
    expect(result.success).toBe(false);
  });

  it("rejects a line outside the closed enum", () => {
    const result = caratulaSchema.safeParse({ line: "moto" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-COP currency", () => {
    const result = caratulaSchema.safeParse({ currency: "USD" });
    expect(result.success).toBe(false);
  });

  it("rejects an impossible calendar date", () => {
    const result = caratulaSchema.safeParse({ endDate: "2026-02-30" });
    expect(result.success).toBe(false);
  });

  it("rejects endDate before startDate", () => {
    const result = caratulaSchema.safeParse({
      startDate: "2027-01-15",
      endDate: "2026-01-15",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a premiumAmount with thousands separators", () => {
    const result = caratulaSchema.safeParse({ premiumAmount: "1,250,000.00" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric premiumAmount", () => {
    const result = caratulaSchema.safeParse({ premiumAmount: "abc" });
    expect(result.success).toBe(false);
  });
});
