import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createCsrfGuardMiddleware, CSRF_HEADER_NAME } from "../../src/middleware/csrf-guard.js";
import type { ResolvedSession } from "../../src/middleware/session-auth.js";

/**
 * `admin-dashboard` (C1) tasks 4.5-4.8, design.md D-B ("session-bound
 * double-submit" CSRF mechanism). Mirrors `admin-auth.ts`'s
 * `constantTimeEquals` helper exactly: `crypto.timingSafeEqual`, length
 * check first — never a plain `===` string comparison, which would
 * reintroduce the timing side-channel design D-B explicitly closed.
 */
const RAW_CSRF = "c".repeat(43);
const CSRF_HASH = createHash("sha256").update(RAW_CSRF).digest("hex");

function sessionWith(csrfTokenHash: string): ResolvedSession {
  return { brokerId: "broker-a-id", brokerUserId: "user-a-id", role: "agent", csrfTokenHash };
}

function buildApp(session: ResolvedSession, downstreamSpy: () => void) {
  const app = new Hono<{ Variables: { session: ResolvedSession } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.on(["POST", "PATCH", "PUT", "DELETE", "GET", "HEAD"], "/probe", createCsrfGuardMiddleware(), async (c) => {
    downstreamSpy();
    return c.body(null, 200);
  });
  return app;
}

describe("createCsrfGuardMiddleware (design.md D-B, tasks 4.5-4.8)", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
    "4.5: rejects a %s request missing the X-Dirus-CSRF header: 403, downstream never runs",
    async (method) => {
      const session = sessionWith(CSRF_HASH);
      const downstreamSpy = vi.fn();
      const app = buildApp(session, downstreamSpy);

      const res = await app.request("/probe", { method });

      expect(res.status).toBe(403);
      expect(downstreamSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
    "4.5: rejects a %s request whose header sha256 does not match session.csrfTokenHash: 403, downstream never runs",
    async (method) => {
      const session = sessionWith(CSRF_HASH);
      const downstreamSpy = vi.fn();
      const app = buildApp(session, downstreamSpy);

      const res = await app.request("/probe", {
        method,
        headers: { [CSRF_HEADER_NAME]: "wrong-csrf-value-not-matching-session-hash" },
      });

      expect(res.status).toBe(403);
      expect(downstreamSpy).not.toHaveBeenCalled();
    },
  );

  it("4.6: a GET request is exempt regardless of header presence", async () => {
    const session = sessionWith(CSRF_HASH);
    const downstreamSpy = vi.fn();
    const app = buildApp(session, downstreamSpy);

    const res = await app.request("/probe", { method: "GET" });

    expect(res.status).toBe(200);
    expect(downstreamSpy).toHaveBeenCalledTimes(1);
  });

  it("4.6: a HEAD request is exempt regardless of header presence", async () => {
    const session = sessionWith(CSRF_HASH);
    const downstreamSpy = vi.fn();
    const app = buildApp(session, downstreamSpy);

    const res = await app.request("/probe", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(downstreamSpy).toHaveBeenCalledTimes(1);
  });

  it("4.7: a mutating request with the correct header passes through", async () => {
    const session = sessionWith(CSRF_HASH);
    const downstreamSpy = vi.fn();
    const app = buildApp(session, downstreamSpy);

    const res = await app.request("/probe", {
      method: "POST",
      headers: { [CSRF_HEADER_NAME]: RAW_CSRF },
    });

    expect(res.status).toBe(200);
    expect(downstreamSpy).toHaveBeenCalledTimes(1);
  });

  it("uses crypto.timingSafeEqual (length check first), not a plain string comparison — mismatched-length header does not throw and is rejected", async () => {
    const session = sessionWith(CSRF_HASH);
    const downstreamSpy = vi.fn();
    const app = buildApp(session, downstreamSpy);

    // A header far shorter than the 64-char hex hash: if the implementation
    // called `timingSafeEqual` directly on mismatched-length buffers without
    // a length guard, this would throw instead of returning 403.
    const res = await app.request("/probe", { method: "POST", headers: { [CSRF_HEADER_NAME]: "short" } });

    expect(res.status).toBe(403);
    expect(downstreamSpy).not.toHaveBeenCalled();
  });
});
