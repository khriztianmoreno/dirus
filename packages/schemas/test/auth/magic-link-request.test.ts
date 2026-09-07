import { describe, expect, it } from "vitest";
import { magicLinkRequestSchema } from "../../src/auth/magic-link-request.js";

/**
 * `admin-dashboard` (C1) task 3.4, design.md D-C, broker-auth spec "Magic-
 * Link Request Endpoint". This is the request-body validation only — it
 * says nothing about whether the email resolves to a `broker_users` row
 * (that is the route's job, task 3.6+). A syntactically valid email always
 * passes here, known or unknown.
 */
describe("magicLinkRequestSchema (design.md D-C, task 3.4)", () => {
  it("accepts a syntactically valid email", () => {
    const result = magicLinkRequestSchema.safeParse({ email: "ana@brokerx.com" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("ana@brokerx.com");
    }
  });

  it("rejects a non-email-shaped value", () => {
    const result = magicLinkRequestSchema.safeParse({ email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects a body missing the email field entirely", () => {
    const result = magicLinkRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
