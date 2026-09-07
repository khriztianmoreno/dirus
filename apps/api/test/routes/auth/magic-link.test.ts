import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerMagicLinkRoute } from "../../../src/routes/auth/magic-link.js";
import type { AppVariables } from "../../../src/app.js";

/**
 * `admin-dashboard` (C1) tasks 3.6-3.11, design.md D-C's exact ordering,
 * broker-auth spec "Magic-Link Request Endpoint", "Anti-Enumeration Response
 * Is Indistinguishable". Everything here is offline: `resolveBrokerIdByEmail`,
 * `issueMagicLinkToken`, and `sendMagicLink` are all injected fakes — zero
 * `@dirus/db`/`@dirus/integrations` import reachable from this test's import
 * graph, mirroring `app.test.ts`'s stated convention.
 */
const DASHBOARD_BASE_URL = "https://app.dirus.io";

function buildApp(opts: {
  resolveBrokerIdByEmail?: ReturnType<typeof vi.fn>;
  issueMagicLinkToken?: ReturnType<typeof vi.fn>;
  sendMagicLink?: ReturnType<typeof vi.fn>;
}) {
  const resolveBrokerIdByEmail = opts.resolveBrokerIdByEmail ?? vi.fn(async () => null);
  const issueMagicLinkToken = opts.issueMagicLinkToken ?? vi.fn(async () => undefined);
  const sendMagicLink = opts.sendMagicLink ?? vi.fn(async () => undefined);

  const app = new Hono<{ Variables: AppVariables }>();
  registerMagicLinkRoute(app, {
    resolveBrokerIdByEmail,
    issueMagicLinkToken,
    sendMagicLink,
    dashboardBaseUrl: DASHBOARD_BASE_URL,
  });

  return { app, resolveBrokerIdByEmail, issueMagicLinkToken, sendMagicLink };
}

function post(app: Hono<{ Variables: AppVariables }>, body: unknown) {
  return app.request("/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /auth/magic-link (design.md D-C, tasks 3.6-3.11)", () => {
  it("task 3.6: dispatches sendMagicLink exactly once, AFTER issueMagicLinkToken (the fake commit) resolves, never before — ordering via call-order spies", async () => {
    const callOrder: string[] = [];
    const issueMagicLinkToken = vi.fn(async () => {
      callOrder.push("issueMagicLinkToken");
    });
    const sendMagicLink = vi.fn(async () => {
      callOrder.push("sendMagicLink");
    });
    const resolveBrokerIdByEmail = vi.fn(async () => "broker-1");
    const { app } = buildApp({ resolveBrokerIdByEmail, issueMagicLinkToken, sendMagicLink });

    const res = await post(app, { email: "ana@brokerx.com" });
    await res.text();

    expect(sendMagicLink).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["issueMagicLinkToken", "sendMagicLink"]);
  });

  it("task 3.7: a known email writes exactly one hashed-token insert (never the raw token) with an expiresAt ~15 minutes out, and the raw token reaches only sendMagicLink", async () => {
    const resolveBrokerIdByEmail = vi.fn(async () => "broker-1");
    const issueMagicLinkToken = vi.fn(async () => undefined);
    const sendMagicLink = vi.fn(async () => undefined);
    const { app } = buildApp({ resolveBrokerIdByEmail, issueMagicLinkToken, sendMagicLink });

    const before = Date.now();
    const res = await post(app, { email: "ana@brokerx.com" });
    await res.text();
    const after = Date.now();

    expect(issueMagicLinkToken).toHaveBeenCalledTimes(1);
    const call = issueMagicLinkToken.mock.calls[0][0] as {
      brokerId: string;
      email: string;
      tokenHash: string;
      expiresAt: Date;
    };
    expect(call.brokerId).toBe("broker-1");
    expect(call.email).toBe("ana@brokerx.com");
    expect(call.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const expectedMin = before + 15 * 60 * 1000;
    const expectedMax = after + 15 * 60 * 1000;
    expect(call.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(call.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);

    expect(sendMagicLink).toHaveBeenCalledTimes(1);
    const [to, url] = sendMagicLink.mock.calls[0] as [string, string];
    expect(to).toBe("ana@brokerx.com");

    // The raw token is embedded in the URL passed to sendMagicLink, and its
    // SHA-256 hex digest must equal the hash passed to the writer — proving
    // the raw value itself never reached the writer.
    const rawToken = new URL(url).searchParams.get("token");
    expect(rawToken).toBeTruthy();
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(rawToken as string).digest("hex")).toBe(call.tokenHash);
    // The writer's own call args must never contain the raw token string.
    expect(JSON.stringify(call)).not.toContain(rawToken);
  });

  it("task 3.8: an unknown email results in zero writer calls and zero sendMagicLink calls", async () => {
    const resolveBrokerIdByEmail = vi.fn(async () => null);
    const issueMagicLinkToken = vi.fn(async () => undefined);
    const sendMagicLink = vi.fn(async () => undefined);
    const { app } = buildApp({ resolveBrokerIdByEmail, issueMagicLinkToken, sendMagicLink });

    const res = await post(app, { email: "ghost@nowhere.com" });
    await res.text();

    expect(issueMagicLinkToken).not.toHaveBeenCalled();
    expect(sendMagicLink).not.toHaveBeenCalled();
  });

  it("task 3.9 (the single most load-bearing test in this phase): byte-identical response bodies AND status codes across a known email, an unknown-but-well-formed email, and a well-formed email resolving to null, with no Set-Cookie and no differing correlation-id-shaped header", async () => {
    const known = buildApp({ resolveBrokerIdByEmail: vi.fn(async () => "broker-1") });
    const unknown = buildApp({ resolveBrokerIdByEmail: vi.fn(async () => null) });
    const nullSemantics = buildApp({ resolveBrokerIdByEmail: vi.fn(async () => null) });

    const resKnown = await post(known.app, { email: "ana@brokerx.com" });
    const resUnknown = await post(unknown.app, { email: "ghost@nowhere.com" });
    const resNull = await post(nullSemantics.app, { email: "wa-only@brokerx.com" });

    const [statusKnown, statusUnknown, statusNull] = [resKnown.status, resUnknown.status, resNull.status];
    expect(statusKnown).toBe(202);
    expect(statusUnknown).toBe(202);
    expect(statusNull).toBe(202);

    // Byte-identical `res.text()` string equality — NOT `res.json()`
    // structural equality, per the task brief: a differently-ordered but
    // structurally-equal JSON body must not silently pass.
    const [textKnown, textUnknown, textNull] = await Promise.all([resKnown.text(), resUnknown.text(), resNull.text()]);
    expect(textKnown).toBe(textUnknown);
    expect(textUnknown).toBe(textNull);

    for (const res of [resKnown, resUnknown, resNull]) {
      expect(res.headers.get("set-cookie")).toBeNull();
    }

    // No differing correlation-id-shaped header across the three (e.g.
    // x-request-id / x-correlation-id) — none of the responses may carry
    // one at all, since none is set anywhere in this route.
    const correlationHeaderNames = ["x-request-id", "x-correlation-id"];
    for (const res of [resKnown, resUnknown, resNull]) {
      for (const name of correlationHeaderNames) {
        expect(res.headers.get(name)).toBeNull();
      }
    }
  });

  it("task 3.10: a malformed, non-email-shaped body returns the identical status/body as a well-formed-unknown email", async () => {
    const unknown = buildApp({ resolveBrokerIdByEmail: vi.fn(async () => null) });
    const malformed = buildApp({ resolveBrokerIdByEmail: vi.fn(async () => null) });

    const resUnknown = await post(unknown.app, { email: "ghost@nowhere.com" });
    const resMalformed = await post(malformed.app, { email: "not-an-email" });

    expect(resMalformed.status).toBe(resUnknown.status);
    const [textUnknown, textMalformed] = await Promise.all([resUnknown.text(), resMalformed.text()]);
    expect(textMalformed).toBe(textUnknown);
    expect(malformed.issueMagicLinkToken).not.toHaveBeenCalled();
    expect(malformed.sendMagicLink).not.toHaveBeenCalled();
  });
});
