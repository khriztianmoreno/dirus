import { describe, expect, it } from "vitest";
import { cedulaSchema } from "../src/cedula.js";

describe("cedulaSchema (cédula -> contacts)", () => {
  it("parses a complete, realistic cédula", () => {
    const result = cedulaSchema.safeParse({
      fullName: "María Fernanda Rodríguez López",
      docType: "CC",
      docNumber: "43987654",
    });

    expect(result.success).toBe(true);
  });

  it("parses a partial extraction — only the printed number is legible", () => {
    const result = cedulaSchema.safeParse({ docNumber: "1128459632" });
    expect(result.success).toBe(true);
  });

  it("parses an empty object — every field is optional on presence", () => {
    expect(cedulaSchema.safeParse({}).success).toBe(true);
  });

  it("rejects a docNumber shorter than 6 digits", () => {
    const result = cedulaSchema.safeParse({ docNumber: "123" });
    expect(result.success).toBe(false);
  });

  it("rejects a docNumber longer than 10 digits", () => {
    const result = cedulaSchema.safeParse({ docNumber: "123456789012" });
    expect(result.success).toBe(false);
  });

  it("rejects a docNumber containing letters", () => {
    const result = cedulaSchema.safeParse({ docNumber: "12A45678" });
    expect(result.success).toBe(false);
  });

  it("rejects a docType other than CC — a 'cedula' doc_class never yields CE/TI/NIT/PA", () => {
    const result = cedulaSchema.safeParse({ docType: "CE" });
    expect(result.success).toBe(false);
  });
});
