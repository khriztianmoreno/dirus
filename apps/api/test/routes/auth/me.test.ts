import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createSessionAuthMiddleware, SESSION_COOKIE_NAME } from "../../../src/middleware/session-auth.js";
import { registerMeRoute } from "../../../src/routes/auth/me.js";
import type { ResolvedSession } from "../../../src/middleware/session-auth.js";
import type { AppVariables } from "../../../src/app.js";

/**
 * `admin-dashboard` (C1) Phase 7, task 7.4. `GET /auth/me` was not part of
 * Phases 1-6's own task list (see `routes/auth/me.ts`'s own docstring) —
 * added minimally here because task 7.4's `RequireSession.tsx` needs it.
 * Mirrors `logout.test.ts`'s fake-resolver pattern exactly: never touches
 * `@dirus/db`, mounts the real `session-auth.ts` middleware with a fake
 * `resolveSession`.
 */
const RAW_SESSION = "s".repeat(43);

const ACTIVE_SESSION: ResolvedSession = {
  brokerId: "broker-a-id",
  brokerUserId: "user-a-id",
  role: "agent",
  csrfTokenHash: "irrelevant-for-this-route",
};

function buildApp(resolveSession: (hash: string) => Promise<ResolvedSession | null>) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("/auth/me", createSessionAuthMiddleware(resolveSession));
  registerMeRoute(app);
  return app;
}

describe("registerMeRoute (task 7.4)", () => {
  it("returns 200 with the resolved session's identity fields when authenticated", async () => {
    const resolveSession = vi.fn(async () => ACTIVE_SESSION);
    const app = buildApp(resolveSession);

    const res = await app.request("/auth/me", {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${RAW_SESSION}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      brokerId: ACTIVE_SESSION.brokerId,
      brokerUserId: ACTIVE_SESSION.brokerUserId,
      role: ACTIVE_SESSION.role,
    });
  });

  it("never leaks the session/CSRF token hash in the response body", async () => {
    const resolveSession = vi.fn(async () => ACTIVE_SESSION);
    const app = buildApp(resolveSession);

    const res = await app.request("/auth/me", {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${RAW_SESSION}` },
    });
    const body = await res.json();

    expect(body).not.toHaveProperty("csrfTokenHash");
  });

  it("returns 401 with no body when unauthenticated (session-auth.ts's own contract, never this route's job)", async () => {
    const resolveSession = vi.fn(async () => null);
    const app = buildApp(resolveSession);

    const res = await app.request("/auth/me");

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });
});
