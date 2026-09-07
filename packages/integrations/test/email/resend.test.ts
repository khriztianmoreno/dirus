import { describe, expect, it, vi } from "vitest";
import { createResendEmailClient } from "../../src/email/resend.js";

/**
 * `admin-dashboard` (C1) task 3.1, O3 (email provider — "no architectural
 * stakes"): Resend, chosen for a deliverability-first API, no SMTP relay to
 * operate, and a workable free tier for pilot volume. Mirrors
 * `chatwoot.ts`'s existing convention IN SPIRIT (design.md D-C task brief):
 * a plain `fetch()` call, not a vendor SDK dependency — `packages/
 * integrations` currently has zero runtime dependencies (see
 * `package.json`), and Resend's own SDK is itself a thin wrapper over the
 * same HTTP API this client calls directly, so adding it would only
 * reintroduce the dependency this package's zero-dep convention avoids.
 * "Mocked SDK client" in the task brief is therefore satisfied here by
 * stubbing global `fetch`, exactly like `chatwoot.test.ts` does — no real
 * network call happens in this test.
 */
describe("createResendEmailClient().sendMagicLink (design.md D-C, task 3.1)", () => {
  it("POSTs to the Resend emails endpoint with the expected to/subject/body shape", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const client = createResendEmailClient({ apiKey: "test-key", fromAddress: "auth@dirus.io" });

    await client.sendMagicLink("ana@brokerx.com", "https://app.dirus.io/auth/callback?token=abc123");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body.from).toBe("auth@dirus.io");
    expect(body.to).toEqual(["ana@brokerx.com"]);
    expect(typeof body.subject).toBe("string");
    expect(body.subject.length).toBeGreaterThan(0);
    expect(String(body.html)).toContain("https://app.dirus.io/auth/callback?token=abc123");

    vi.unstubAllGlobals();
  });

  it("throws when Resend responds with a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "invalid" }), { status: 422 })),
    );

    const client = createResendEmailClient({ apiKey: "test-key", fromAddress: "auth@dirus.io" });

    await expect(client.sendMagicLink("ana@brokerx.com", "https://app.dirus.io/auth/callback?token=abc")).rejects.toThrow(
      /422/,
    );

    vi.unstubAllGlobals();
  });
});
