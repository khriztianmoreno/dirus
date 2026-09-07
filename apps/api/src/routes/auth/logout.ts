import { getCookie } from "hono/cookie";
import type { Hono } from "hono";
import type { AppVariables } from "../../app.js";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../../middleware/session-auth.js";
import type { RevokeSessionFn } from "../../services/auth/revoke-session.js";

/**
 * `POST /auth/logout` (`admin-dashboard` (C1) tasks 4.11-4.12, broker-auth
 * spec "Logout Invalidates the Session"). Mounted behind `session-auth.ts`
 * (401 for an unauthenticated/already-revoked cookie) and `csrf-guard.ts`
 * (this is a mutating request) — this route itself performs neither check,
 * mirroring every other route's "auth is the middleware's job, never the
 * route's" convention in this codebase.
 *
 * Reads the raw `dirus_session` cookie directly (the same way
 * `session-auth.ts` does) rather than extending `ResolvedSession`
 * (design.md D-D's exact type contract) with a `sessionTokenHash` field —
 * `c.var.session` intentionally carries no raw/hashed token material, only
 * the resolved identity. Hashing the SAME raw cookie value a second time
 * here is cheap and keeps `ResolvedSession`'s shape exactly as design.md
 * D-D specifies it, with no field added just to serve this one route.
 */
export type LogoutRouteOptions = {
  revokeSession: RevokeSessionFn;
};

export function registerLogoutRoute(app: Hono<{ Variables: AppVariables }>, { revokeSession }: LogoutRouteOptions): void {
  app.post("/auth/logout", async (c) => {
    const raw = getCookie(c, SESSION_COOKIE_NAME);

    // session-auth.ts already rejected any request without a well-formed,
    // resolvable cookie before this route runs — `raw` is always present
    // here. The guard below is defensive only, never reachable in practice.
    if (raw) {
      await revokeSession({ brokerId: c.var.brokerId, sessionTokenHash: hashSessionToken(raw) });
    }

    // Clear both cookies (Max-Age=0) so the browser drops them immediately,
    // in addition to the server-side revocation above.
    c.header("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`, {
      append: true,
    });
    c.header("Set-Cookie", `dirus_csrf=; Secure; SameSite=Lax; Path=/; Max-Age=0`, { append: true });

    return c.body(null, 204);
  });
}
