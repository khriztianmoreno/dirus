import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWebhookAuthMiddleware } from "../../src/middleware/webhook-auth.js";

/**
 * Design D-4: "a rotating shared-secret bearer credential (a compensating
 * control, NOT a signature)". Task 5.2/5.3: a request missing the token, or
 * presenting a wrong-length/incorrect token, is rejected with 401 and no
 * detail in the body, and — critically — nothing downstream of this
 * middleware (here, a fake tenant-resolver spy standing in for
 * `middleware/tenant-resolver.ts`) ever runs. A valid token passes through.
 */
const EXPECTED_TOKEN = "a".repeat(32);

function buildApp(spy: () => void) {
  const app = new Hono();
  app.post("/webhooks/chatwoot", createWebhookAuthMiddleware(EXPECTED_TOKEN), async (c) => {
    spy();
    return c.json({ ok: true });
  });
  return app;
}

describe("createWebhookAuthMiddleware (design D-4: compensating control, not a signature)", () => {
  it("rejects a request with no token: 401, empty body, downstream never runs", async () => {
    const spy = vi.fn();
    const app = buildApp(spy);

    const res = await app.request("/webhooks/chatwoot", { method: "POST", body: "{}" });

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    // No detail in the body (design D-4) — an attacker probing the endpoint
    // must not learn WHY it failed. The body is empty, not a JSON error
    // object explaining the rejection.
    const bodyText = await res.text();
    expect(bodyText).toBe("");
  });

  it("rejects a wrong-length token: 401, downstream never runs", async () => {
    const spy = vi.fn();
    const app = buildApp(spy);

    const res = await app.request("/webhooks/chatwoot", {
      method: "POST",
      headers: { "X-Dirus-Webhook-Token": "too-short" },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an incorrect (but same-length) token: 401, downstream never runs", async () => {
    const spy = vi.fn();
    const app = buildApp(spy);

    const res = await app.request("/webhooks/chatwoot", {
      method: "POST",
      headers: { "X-Dirus-Webhook-Token": "b".repeat(32) },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts a valid token via the X-Dirus-Webhook-Token header: downstream runs", async () => {
    const spy = vi.fn();
    const app = buildApp(spy);

    const res = await app.request("/webhooks/chatwoot", {
      method: "POST",
      headers: { "X-Dirus-Webhook-Token": EXPECTED_TOKEN },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid token via the URL path segment when the header is absent", async () => {
    const spy = vi.fn();
    const app = new Hono();
    app.post(
      "/webhooks/chatwoot/:token",
      createWebhookAuthMiddleware(EXPECTED_TOKEN),
      async (c) => {
        spy();
        return c.json({ ok: true });
      },
    );

    const res = await app.request(`/webhooks/chatwoot/${EXPECTED_TOKEN}`, { method: "POST", body: "{}" });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
