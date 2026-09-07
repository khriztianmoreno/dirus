import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createTenantResolverMiddleware } from "../../src/middleware/tenant-resolver.js";

/**
 * Design D-1/D-5, spec "Tenant Resolution by chatwoot_account_id" (F2.1
 * corrected the resolution key from `wa_phone_number_id` to
 * `chatwoot_account_id`, design D-A/D-E): given a known key, resolves and
 * sets `c.var.brokerId`; given an unknown key, rejects with no `brokerId`
 * set and never guesses/defaults one. Task 5.6/4.1: an unknown key emits an
 * operational log line containing ONLY the `chatwoot_account_id` — never
 * message body, sender name, or any other payload field (spec P4).
 *
 * Uses a FAKE `resolveBrokerIdByChatwootAccountId`, never the real
 * `@dirus/db` export, so this stays fully offline (design D-5). The fake is
 * typed `(accountId: number) => Promise<string | null>` — a fake typed to
 * the old `(key: string) => ...` shape is a compile error (design D-E).
 */
function buildApp(resolveBrokerId: (accountId: number) => Promise<string | null>, downstreamSpy: () => void) {
  const app = new Hono<{ Variables: { resolutionKey: number; brokerId: string } }>();
  app.post(
    "/probe/:key",
    async (c, next) => {
      c.set("resolutionKey", Number(c.req.param("key")));
      await next();
    },
    createTenantResolverMiddleware(resolveBrokerId),
    async (c) => {
      downstreamSpy();
      return c.json({ brokerId: c.var.brokerId });
    },
  );
  return app;
}

describe("createTenantResolverMiddleware (design D-1/D-5)", () => {
  it("sets c.var.brokerId for a known key and runs downstream", async () => {
    const resolveBrokerId = vi.fn(async (accountId: number) => (accountId === 1001 ? "broker-a-id" : null));
    const downstreamSpy = vi.fn();
    const app = buildApp(resolveBrokerId, downstreamSpy);

    const res = await app.request("/probe/1001", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ brokerId: "broker-a-id" });
    expect(downstreamSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown key: no brokerId set, downstream never runs, never guesses/defaults", async () => {
    const resolveBrokerId = vi.fn(async () => null);
    const downstreamSpy = vi.fn();
    const app = buildApp(resolveBrokerId, downstreamSpy);

    const res = await app.request("/probe/999999", { method: "POST" });

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(downstreamSpy).not.toHaveBeenCalled();
  });

  it("logs an operational line containing ONLY chatwoot_account_id on an unknown key — never other payload fields (spec P4)", async () => {
    const resolveBrokerId = vi.fn(async () => null);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const app = buildApp(resolveBrokerId, vi.fn());
    await app.request("/probe/424242", { method: "POST" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = logSpy.mock.calls[0];
    const loggedText = loggedArgs.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");

    expect(loggedText).toContain("424242");
    // Negative assertions: none of these words, which a message body/
    // sender name/other payload field would plausibly contain, appear in
    // the logged text.
    expect(loggedText).not.toMatch(/message body|sender|content|full_?name/i);

    logSpy.mockRestore();
  });
});
