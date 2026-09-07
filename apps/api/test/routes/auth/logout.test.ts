import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createSessionAuthMiddleware, hashSessionToken, SESSION_COOKIE_NAME } from "../../../src/middleware/session-auth.js";
import { createCsrfGuardMiddleware, CSRF_HEADER_NAME } from "../../../src/middleware/csrf-guard.js";
import { registerLogoutRoute } from "../../../src/routes/auth/logout.js";
import type { ResolvedSession } from "../../../src/middleware/session-auth.js";
import type { AppVariables } from "../../../src/app.js";

/**
 * `admin-dashboard` (C1) task 4.11, broker-auth spec "Logout Invalidates
 * the Session". `revokeSession` is a fake write function (never real
 * `@dirus/db`), asserted to be called with the current session's
 * `brokerId`/`sessionTokenHash`.
 *
 * The scenario "the same cookie presented afterward is treated as
 * unauthenticated" is asserted AT THE RESOLVER-FAKE LEVEL, per the task
 * brief: this suite never touches the real `resolveSession` (task 4.12,
 * which needs a live database to prove `revoked_at IS NULL` filtering) —
 * instead it simulates the real resolver's post-revocation behavior by
 * making the fake `resolveSession` return `null` for a second call with the
 * same cookie, mirroring how the real resolver WOULD behave once
 * `revokeSession` has run (proven live only in `resolve-session.live.test.ts`
 * / `logout.live.test.ts`, task 4.13).
 */
const RAW_SESSION = "s".repeat(43);
const RAW_CSRF = "c".repeat(43);
const CSRF_HASH_HEX = "csrf-hash-hex-value-for-the-active-session";

const ACTIVE_SESSION: ResolvedSession = {
  brokerId: "broker-a-id",
  brokerUserId: "user-a-id",
  role: "agent",
  csrfTokenHash: CSRF_HASH_HEX,
};

function buildApp(resolveSession: (hash: string) => Promise<ResolvedSession | null>, revokeSession: (...args: unknown[]) => Promise<void>) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("/auth/logout", createSessionAuthMiddleware(resolveSession), createCsrfGuardMiddleware());
  registerLogoutRoute(app, { revokeSession: revokeSession as never });
  return app;
}

function authedHeaders(): HeadersInit {
  return {
    Cookie: `${SESSION_COOKIE_NAME}=${RAW_SESSION}`,
    [CSRF_HEADER_NAME]: RAW_CSRF,
  };
}

describe("registerLogoutRoute (task 4.11, broker-auth spec 'Logout Invalidates the Session')", () => {
  it("4.11: logout revokes the current session via the injected write function, called with the resolved brokerId/sessionTokenHash", async () => {
    // csrf-guard needs session.csrfTokenHash to match sha256(RAW_CSRF).
    const { createHash } = await import("node:crypto");
    const csrfHash = createHash("sha256").update(RAW_CSRF).digest("hex");
    const resolveSession = vi.fn(async () => ({ ...ACTIVE_SESSION, csrfTokenHash: csrfHash }));
    const revokeSession = vi.fn(async () => undefined);
    const app = buildApp(resolveSession, revokeSession);

    const res = await app.request("/auth/logout", { method: "POST", headers: authedHeaders() });

    expect(res.status).toBeLessThan(300);
    expect(revokeSession).toHaveBeenCalledTimes(1);
    expect(revokeSession).toHaveBeenCalledWith({
      brokerId: ACTIVE_SESSION.brokerId,
      sessionTokenHash: hashSessionToken(RAW_SESSION),
    });
  });

  it("4.11: the same cookie presented afterward is treated as unauthenticated — asserted at the resolver-fake level (resolveSession now returns null, simulating the real post-revocation resolver)", async () => {
    const { createHash } = await import("node:crypto");
    const csrfHash = createHash("sha256").update(RAW_CSRF).digest("hex");
    let revoked = false;
    const resolveSession = vi.fn(async () => (revoked ? null : { ...ACTIVE_SESSION, csrfTokenHash: csrfHash }));
    const revokeSession = vi.fn(async () => {
      revoked = true;
    });
    const app = buildApp(resolveSession, revokeSession);

    const logoutRes = await app.request("/auth/logout", { method: "POST", headers: authedHeaders() });
    expect(logoutRes.status).toBeLessThan(300);

    const secondAttempt = await app.request("/auth/logout", { method: "POST", headers: authedHeaders() });
    expect(secondAttempt.status).toBe(401);
  });
});
