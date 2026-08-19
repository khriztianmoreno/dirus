import { describe, expect, it } from "vitest";
import { colombianPlateSchema } from "../src/primitives.js";

describe("colombianPlateSchema (normalisation precedes format validation)", () => {
  it("normalises a lowercase plate to uppercase before validating", () => {
    const result = colombianPlateSchema.safeParse("abc123");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("ABC123");
    }
  });

  it("trims stray whitespace before validating", () => {
    const result = colombianPlateSchema.safeParse(" ABC123 ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("ABC123");
    }
  });

  it("normalises a mixed-case, whitespace-padded plate to the uppercase value", () => {
    const result = colombianPlateSchema.safeParse("  aBc123  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("ABC123");
    }
  });
});
