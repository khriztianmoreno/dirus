import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerCallbackRoute } from "../../../src/routes/auth/callback.js";
import type { AppVariables } from "../../../src/app.js";

/**
 * `admin-dashboard` (C1) tasks 3.12-3.15, design.md D-A's callback
 * data-flow, broker-auth spec "Token Consumption Is Single-Use", "Token
 * Expiry Is Enforced Server-Side". `resolveBrokerIdByMagicLinkTokenHash`,
 * `consumeMagicLinkToken`, and `createSession` are all injected fakes —
 * zero `@dirus/db` import reachable from this test's import graph.
 */
const DASHBOARD_BASE_URL = "https://app.dirus.io";
const RAW_TOKEN = "raw-token-value-abc123";

function buildApp(opts: {
  resolveBrokerIdByMagicLinkTokenHash?: ReturnType<typeof vi.fn>;
  consumeMagicLinkToken?: ReturnType<typeof vi.fn>;
  createSession?: ReturnType<typeof vi.fn>;
}) {
  const resolveBrokerIdByMagicLinkTokenHash =
    opts.resolveBrokerIdByMagicLinkTokenHash ?? vi.fn(async () => "broker-1");
  const consumeMagicLinkToken =
    opts.consumeMagicLinkToken ?? vi.fn(async () => ({ ok: true as const, brokerUserId: "user-1" }));
  const createSession =
    opts.createSession ?? vi.fn(async () => ({ rawSessionToken: "s".repeat(43), rawCsrfToken: "c".repeat(43) }));

  const app = new Hono<{ Variables: AppVariables }>();
  registerCallbackRoute(app, {
    resolveBrokerIdByMagicLinkTokenHash,
    consumeMagicLinkToken,
    createSession,
    dashboardBaseUrl: DASHBOARD_BASE_URL,
  });

  return { app, resolveBrokerIdByMagicLinkTokenHash, consumeMagicLinkToken, createSession };
}

function getCallback(app: Hono<{ Variables: AppVariables }>, token?: string) {
  const query = token !== undefined ? `?token=${encodeURIComponent(token)}` : "";
  return app.request(`/auth/callback${query}`, { method: "GET", redirect: "manual" });
}

describe("GET /auth/callback (design.md D-A, tasks 3.12-3.15)", () => {
  it("task 3.12: a valid, unused, unexpired token results in a session-creation call and a 302 redirect with a Set-Cookie header; the raw token never appears in Location", async () => {
    const createSession = vi.fn(async () => ({ rawSessionToken: "s".repeat(43), rawCsrfToken: "c".repeat(43) }));
    const { app } = buildApp({ createSession });

    const res = await getCallback(app, RAW_TOKEN);

    expect(res.status).toBe(302);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({ brokerId: "broker-1", brokerUserId: "user-1" });
    expect(res.headers.get("set-cookie")).toBeTruthy();

    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain(RAW_TOKEN);
  });

  it("task 3.13: a second presentation of the same token (fake atomic-consume returns already-used) is rejected, no new session call happens", async () => {
    const consumeMagicLinkToken = vi.fn(async () => ({ ok: false as const }));
    const createSession = vi.fn(async () => ({ rawSessionToken: "s".repeat(43), rawCsrfToken: "c".repeat(43) }));
    const { app } = buildApp({ consumeMagicLinkToken, createSession });

    const res = await getCallback(app, RAW_TOKEN);

    expect(res.status).toBe(302);
    expect(createSession).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("task 3.14: an expired-but-unused token (fake atomic-consume returns expired) is rejected, no session call happens", async () => {
    const consumeMagicLinkToken = vi.fn(async () => ({ ok: false as const }));
    const createSession = vi.fn(async () => ({ rawSessionToken: "s".repeat(43), rawCsrfToken: "c".repeat(43) }));
    const { app } = buildApp({ consumeMagicLinkToken, createSession });

    const res = await getCallback(app, RAW_TOKEN);

    expect(res.status).toBe(302);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("an unresolvable token hash (unknown key) is rejected before any consume/session call", async () => {
    const resolveBrokerIdByMagicLinkTokenHash = vi.fn(async () => null);
    const consumeMagicLinkToken = vi.fn(async () => ({ ok: true as const, brokerUserId: "user-1" }));
    const createSession = vi.fn(async () => ({ rawSessionToken: "s".repeat(43), rawCsrfToken: "c".repeat(43) }));
    const { app } = buildApp({ resolveBrokerIdByMagicLinkTokenHash, consumeMagicLinkToken, createSession });

    const res = await getCallback(app, RAW_TOKEN);

    expect(res.status).toBe(302);
    expect(consumeMagicLinkToken).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("a missing token query param is rejected without calling any injected dependency", async () => {
    const resolveBrokerIdByMagicLinkTokenHash = vi.fn(async () => "broker-1");
    const { app, consumeMagicLinkToken, createSession } = buildApp({ resolveBrokerIdByMagicLinkTokenHash });

    const res = await getCallback(app, undefined);

    expect(res.status).toBe(302);
    expect(resolveBrokerIdByMagicLinkTokenHash).not.toHaveBeenCalled();
    expect(consumeMagicLinkToken).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
