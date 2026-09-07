import { describe, expect, it } from "vitest";
import { correctionRequestSchema } from "../../src/dashboard/correction-request.js";

/**
 * `admin-dashboard` (C1) tasks 5.9-5.12, design.md D-E. Not RED-marked as
 * its own tasks.md line (the correction-endpoint RED tasks 5.9-5.11 live in
 * `review-queue.test.ts`), but TDD-authored anyway alongside
 * `correction-request.ts`, mirroring Phase 4 task 4.14's documented
 * convention for a structural schema file with no dedicated RED task.
 */
describe("correctionRequestSchema (design.md D-E, tasks 5.9-5.12)", () => {
  it("accepts a body with correctedOutput", () => {
    const result = correctionRequestSchema.safeParse({ correctedOutput: { endDate: "2027-06-01" } });
    expect(result.success).toBe(true);
  });

  it("rejects a body missing correctedOutput entirely (task 5.11)", () => {
    const result = correctionRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("silently strips an unrecognized correctedBy field — never surfaces it on the parsed data (task 5.9)", () => {
    const result = correctionRequestSchema.safeParse({
      correctedOutput: { endDate: "2027-06-01" },
      correctedBy: "attacker-supplied-broker-user-id",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("correctedBy" in result.data).toBe(false);
      expect(Object.keys(result.data)).toEqual(["correctedOutput"]);
    }
  });
});
