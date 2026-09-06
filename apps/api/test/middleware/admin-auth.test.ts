import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAdminAuthMiddleware } from "../../src/middleware/admin-auth.js";

/**
 * Proposal P2: a provisional shared-bearer-token auth for
 * `/admin/policies/import`, mirroring `webhook-auth.ts`'s design D-4
 * pattern exactly (fixed-length secret, `crypto.timingSafeEqual`, 401 with
 * empty body on failure) — except header-only, no path-segment fallback.
 * F2's path-segment fallback exists because Chatwoot may only permit
 * configuring a URL; an admin caller can always set a header, so that
 * fallback does not apply here (proposal P2, task 3.5).
 *
 * Task 3.3/3.4: a request missing the `X-Dirus-Admin-Token` header, or
 * presenting a wrong-length/incorrect token, is rejected with 401 and an
 * empty body, and — critically — nothing downstream (here, a spy standing
 * in for the eventual size/shape guards and import service) ever runs. A
 * valid token passes through.
 */
const EXPECTED_TOKEN = "a".repeat(32);

function buildApp(spy: () => void) {
  const app = new Hono();
  app.post("/admin/policies/import", createAdminAuthMiddleware(EXPECTED_TOKEN), async (c) => {
    spy();
    return c.json({ ok: true });
  });
  return app;
}

describe("createAdminAuthMiddleware (proposal P2: compensating control, header-only, no path fallback)", () => {
  it("rejects a request with no token: 401, empty body, downstream never runs", async () => {
    const spy = vi.fn();
    const app = buildApp(spy);

    const res = await app.request("/admin/policies/import", { method: "POST", body: "{}" });

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    // No detail in the body — an attacker probing the endpoint must not
    // learn why the request failed.
    const bodyText = await res.text();
    expect(bodyText).toBe("");
  });

  it("rejects a wrong-length token: 401, downstream never runs", async () => {
    const spy = vi.fn();
    const app = buildApp(spy);

    const res = await app.request("/admin/policies/import", {
      method: "POST",
      headers: { "X-Dirus-Admin-Token": "too-short" },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an incorrect (but same-length) token: 401, downstream never runs", async () => {
    const spy = vi.fn();
    const app = buildApp(spy);

    const res = await app.request("/admin/policies/import", {
      method: "POST",
      headers: { "X-Dirus-Admin-Token": "b".repeat(32) },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts a valid token via the X-Dirus-Admin-Token header: downstream runs", async () => {
    const spy = vi.fn();
    const app = buildApp(spy);

    const res = await app.request("/admin/policies/import", {
      method: "POST",
      headers: { "X-Dirus-Admin-Token": EXPECTED_TOKEN },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not accept a valid token via a URL path segment (no fallback, unlike webhook-auth)", async () => {
    const spy = vi.fn();
    const app = new Hono();
    app.post(
      "/admin/policies/import/:token",
      createAdminAuthMiddleware(EXPECTED_TOKEN),
      async (c) => {
        spy();
        return c.json({ ok: true });
      },
    );

    const res = await app.request(`/admin/policies/import/${EXPECTED_TOKEN}`, {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });
});
