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

  it("accepts a valid PA (passport) owner document number, alphanumeric", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      ownerDocType: "PA",
      ownerDocNumber: "AB123456",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid NIT owner document number with a hyphenated verification digit", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      ownerDocType: "NIT",
      ownerDocNumber: "900123456-7",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid CE (cédula de extranjería) owner document number outside the CC 6-10 digit range", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      ownerDocType: "CE",
      ownerDocNumber: "123456789012",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid TI owner document number", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      ownerDocType: "TI",
      ownerDocNumber: "1098765432",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a PA owner document number that is not alphanumeric-shaped (too short)", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      ownerDocType: "PA",
      ownerDocNumber: "A1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a NIT owner document number with a malformed verification digit segment", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      ownerDocType: "NIT",
      ownerDocNumber: "900123456-77",
    });
    expect(result.success).toBe(false);
  });

  it("still rejects a CC owner document number with punctuation (default docType behavior unchanged)", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      ownerDocType: "CC",
      ownerDocNumber: "793-456-12",
    });
    expect(result.success).toBe(false);
  });

  it("defaults to the CC digit pattern when ownerDocType is absent (unchanged prior behavior)", () => {
    const result = tarjetaPropiedadSchema.safeParse({ ownerDocNumber: "AB123456" });
    expect(result.success).toBe(false);
  });

  it("silently strips an unknown key instead of rejecting the object (current default Zod behavior, .strict() deliberately not used — see spec's open decision for B2)", () => {
    const result = tarjetaPropiedadSchema.safeParse({
      plate: "ABC123",
      make: "Chevrolet",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("make");
      expect(Object.keys(result.data)).toEqual(["plate"]);
    }
  });
});
