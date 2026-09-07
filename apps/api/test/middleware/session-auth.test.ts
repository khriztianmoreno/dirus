import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createSessionAuthMiddleware, hashSessionToken, SESSION_COOKIE_NAME } from "../../src/middleware/session-auth.js";
import type { ResolvedSession } from "../../src/middleware/session-auth.js";

/**
 * `admin-dashboard` (C1) tasks 4.1-4.3, design.md D-D, broker-auth spec
 * "Session Established as httpOnly Signed Cookie With Sliding Expiry",
 * "brokerId Is Never Accepted From the Client". Mirrors `webhook-auth.test.ts`'s
 * convention exactly: 401 with an empty body on rejection, downstream never
 * runs, asserted via a spy/counter — plus this middleware's own
 * `resolveSession` fake, which must also never be CALLED for a
 * shape-check-failure rejection (task 4.1's extra assertion beyond
 * `webhook-auth.test.ts`'s pattern).
 *
 * Uses a FAKE `ResolveSession`, never the real `@dirus/db`-backed
 * implementation, so this stays fully offline (design.md D-D).
 */
const VALID_SESSION = "s".repeat(43);
const VALID_SESSION_2 = "t".repeat(43);

const RESOLVED: ResolvedSession = {
  brokerId: "broker-a-id",
  brokerUserId: "user-a-id",
  role: "agent",
  csrfTokenHash: "csrf-hash-a",
};

function buildApp(resolveSession: (hash: string) => Promise<ResolvedSession | null>, downstreamSpy: () => void) {
  const app = new Hono<{ Variables: { brokerId: string; session: ResolvedSession } }>();
  app.post("/probe", createSessionAuthMiddleware(resolveSession), async (c) => {
    downstreamSpy();
    return c.json({ brokerId: c.var.brokerId, session: c.var.session });
  });
  return app;
}

function withCookie(name: string, value: string): HeadersInit {
  return { Cookie: `${name}=${value}` };
}

describe("createSessionAuthMiddleware (design.md D-D, tasks 4.1-4.4)", () => {
  it("4.1: rejects a request with no cookie: 401, empty body, resolveSession never called, downstream never runs", async () => {
    const resolveSession = vi.fn(async () => RESOLVED);
    const downstreamSpy = vi.fn();
    const app = buildApp(resolveSession, downstreamSpy);

    const res = await app.request("/probe", { method: "POST" });

    expect(res.status).toBe(401);
    const bodyText = await res.text();
    expect(bodyText).toBe("");
    expect(resolveSession).not.toHaveBeenCalled();
    expect(downstreamSpy).not.toHaveBeenCalled();
  });

  it("4.1: rejects a cookie failing the shape check (wrong length): 401, resolveSession never called, downstream never runs", async () => {
    const resolveSession = vi.fn(async () => RESOLVED);
    const downstreamSpy = vi.fn();
    const app = buildApp(resolveSession, downstreamSpy);

    const res = await app.request("/probe", {
      method: "POST",
      headers: withCookie(SESSION_COOKIE_NAME, "too-short"),
    });

    expect(res.status).toBe(401);
    expect(resolveSession).not.toHaveBeenCalled();
    expect(downstreamSpy).not.toHaveBeenCalled();
  });

  it("4.1: rejects a cookie failing the shape check (non-base64url charset): 401, resolveSession never called, downstream never runs", async () => {
    const resolveSession = vi.fn(async () => RESOLVED);
    const downstreamSpy = vi.fn();
    const app = buildApp(resolveSession, downstreamSpy);

    // Correct length (43), but contains "!" — outside the base64url charset.
    const malformed = `!${"a".repeat(42)}`;
    const res = await app.request("/probe", {
      method: "POST",
      headers: withCookie(SESSION_COOKIE_NAME, malformed),
    });

    expect(res.status).toBe(401);
    expect(resolveSession).not.toHaveBeenCalled();
    expect(downstreamSpy).not.toHaveBeenCalled();
  });

  it("4.2: a well-formed cookie whose hash resolves to null is rejected 401, c.var.brokerId never set, downstream never runs", async () => {
    const resolveSession = vi.fn(async () => null);
    const downstreamSpy = vi.fn();
    const app = buildApp(resolveSession, downstreamSpy);

    const res = await app.request("/probe", {
      method: "POST",
      headers: withCookie(SESSION_COOKIE_NAME, VALID_SESSION),
    });

    expect(res.status).toBe(401);
    expect(resolveSession).toHaveBeenCalledTimes(1);
    expect(resolveSession).toHaveBeenCalledWith(hashSessionToken(VALID_SESSION));
    expect(downstreamSpy).not.toHaveBeenCalled();
  });

  it("4.3: a well-formed cookie that resolves successfully sets c.var.brokerId/session from the resolver alone, never from a conflicting body field", async () => {
    const resolveSession = vi.fn(async () => RESOLVED);
    const downstreamSpy = vi.fn();
    const app = buildApp(resolveSession, downstreamSpy);

    // Adversarial input: the body carries a DIFFERENT brokerId than the
    // session resolves to. Traces to broker-auth spec "A supplied brokerId
    // in the request body is ignored" — a test that never constructs this
    // conflicting value proves nothing.
    const res = await app.request("/probe", {
      method: "POST",
      headers: { ...withCookie(SESSION_COOKIE_NAME, VALID_SESSION), "Content-Type": "application/json" },
      body: JSON.stringify({ brokerId: "broker-B-attacker-supplied-id" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brokerId).toBe(RESOLVED.brokerId);
    expect(body.brokerId).not.toBe("broker-B-attacker-supplied-id");
    expect(body.session).toEqual(RESOLVED);
    expect(downstreamSpy).toHaveBeenCalledTimes(1);
  });

  it("hashes distinct raw cookie values to distinct hashes passed to resolveSession (sanity: not a constant hash)", async () => {
    const resolveSession = vi.fn(async () => RESOLVED);
    const app = buildApp(resolveSession, vi.fn());

    await app.request("/probe", { method: "POST", headers: withCookie(SESSION_COOKIE_NAME, VALID_SESSION) });
    await app.request("/probe", { method: "POST", headers: withCookie(SESSION_COOKIE_NAME, VALID_SESSION_2) });

    const [firstCallHash] = resolveSession.mock.calls[0];
    const [secondCallHash] = resolveSession.mock.calls[1];
    expect(firstCallHash).not.toBe(secondCallHash);
  });
});
