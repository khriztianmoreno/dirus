import { describe, expect, it } from "vitest";
import { tarjetaPropiedadSchema } from "../src/tarjeta-propiedad.js";

describe("tarjetaPropiedadSchema (tarjeta de propiedad -> policies.plate + owner contacts upsert)", () => {
  it("parses a complete, realistic tarjeta de propiedad (car plate)", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      plate: "XYZ789",
      ownerFullName: "Carlos Andrés Gómez",
      ownerDocNumber: "79345612",
      ownerDocType: "CC",
    });

    expect(result.success).toBe(true);
  });

  it("accepts a motorcycle plate format (3 letters + 2 digits + 1 letter)", () => {
    const result = tarjetaPropiedadSchema.safeParse({ plate: "ABC12D" });
    expect(result.success).toBe(true);
  });

  it("parses a partial extraction — only the plate is legible", () => {
    const result = tarjetaPropiedadSchema.safeParse({ plate: "DEF456" });
    expect(result.success).toBe(true);
  });

  it("parses an empty object — every field is optional on presence", () => {
    expect(tarjetaPropiedadSchema.safeParse({}).success).toBe(true);
  });

  it("rejects a plate with a malformed suffix", () => {
    const result = tarjetaPropiedadSchema.safeParse({ plate: "12ABC3" });
    expect(result.success).toBe(false);
  });

  it("rejects a plate that is too short", () => {
    const result = tarjetaPropiedadSchema.safeParse({ plate: "AB12" });
    expect(result.success).toBe(false);
  });

  it("rejects an ownerDocNumber with punctuation", () => {
    const result = tarjetaPropiedadSchema.safeParse({ ownerDocNumber: "793-456-12" });
    expect(result.success).toBe(false);
  });

  it("rejects an ownerDocType outside the closed enum", () => {
    const result = tarjetaPropiedadSchema.safeParse({ ownerDocType: "SSN" });
    expect(result.success).toBe(false);
  });
});
