import { describe, expect, it } from "vitest";
import {
  schemaDeclaresBrokerIdField,
  SESSION_PROTECTED_INPUT_SCHEMAS,
} from "../../src/routes/session-protected-schemas.js";

/**
 * `admin-dashboard` (C1) task 4.14, broker-auth spec "No session-protected
 * route schema declares a brokerId input field". Not RED-marked in
 * tasks.md, but TDD-authored anyway alongside `session-protected-schemas.ts`
 * (mirrors Phase 3 task 3.18's documented convention for a non-RED-marked
 * structural task).
 *
 * The registry is EMPTY in Phase 4 (see `session-protected-schemas.ts`'s
 * own docstring — `logout` has no input schema). Iterating an empty
 * registry alone would prove nothing about whether the check mechanism
 * itself works, so this suite also runs the SAME `schemaDeclaresBrokerIdField`
 * helper against a deliberately "poisoned" schema (never registered — a
 * local-only construction) to confirm the assertion is real, not vacuous.
 * This mirrors this repo's own established mutation-testing convention
 * (`webhook-ingress.live.test.ts`'s "Mutation-testing note") for exactly
 * this "correct by construction, could be vacuously true" situation.
 */
describe("session-protected route input schemas never declare a brokerId field (task 4.14)", () => {
  it("no schema registered in SESSION_PROTECTED_INPUT_SCHEMAS declares brokerId as an accepted input", () => {
    for (const [routeName, schema] of Object.entries(SESSION_PROTECTED_INPUT_SCHEMAS)) {
      expect(schemaDeclaresBrokerIdField(schema), `route "${routeName}" must not declare a brokerId field`).toBe(
        false,
      );
    }
  });

  it("mutation check: the helper DOES flag a schema that declares brokerId — proves the assertion above is not vacuous", () => {
    // Structurally identical to what a real `z.object({...})` exposes
    // (a `.shape` property keyed by field name) — built by hand rather than
    // importing `zod` directly, since `apps/api` has no direct `zod`
    // dependency (see `session-protected-schemas.ts`'s own docstring).
    const poisoned = { shape: { brokerId: {}, otherField: {} } };
    const clean = { shape: { otherField: {} } };

    expect(schemaDeclaresBrokerIdField(poisoned)).toBe(true);
    expect(schemaDeclaresBrokerIdField(clean)).toBe(false);
  });
});
