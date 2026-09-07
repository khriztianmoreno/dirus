import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import type { AppVariables } from "../../app.js";
import { buildCsrfCookieHeader, buildSessionCookieHeader, type CreateSessionFn } from "../../services/auth/session-cookies.js";
import type { ConsumeMagicLinkTokenFn } from "../../services/auth/consume-magic-link.js";

/**
 * `GET /auth/callback?token=…` (`admin-dashboard` (C1) tasks 3.12-3.15,
 * design.md D-A's callback data-flow, broker-auth spec "Token Consumption
 * Is Single-Use", "Token Expiry Is Enforced Server-Side", "Session
 * Established as httpOnly Signed Cookie With Sliding Expiry").
 *
 * Order, per design.md's "CALLBACK" data-flow diagram:
 *
 *   1. `dirus_resolve_broker_id_by_magic_link` (via the injected
 *      `resolveBrokerIdByMagicLinkTokenHash`, design.md D-A) — an unknown
 *      token hash rejects immediately, no consume/session call.
 *   2. `consumeMagicLinkToken` — the atomic single-use + expiry UPDATE
 *      (task 3.15), inside `withBrokerContext(brokerId, ...)`. A rejection
 *      here (replayed or expired) rejects the request, no session call.
 *   3. `createSession` — persists the `sessions` row and returns the raw
 *      session/CSRF values; this route builds and sets both `Set-Cookie`
 *      headers from them (design.md D-B's exact attributes), then
 *      redirects to the dashboard root. The raw token from the query
 *      string never appears in the redirect `Location`.
 *
 * Injected exactly like `magic-link.ts`'s dependencies — never a real
 * `@dirus/db` import here, so this route stays offline-testable (design.md
 * D-D). Only `apps/api/src/index.ts` wires in the real implementations.
 */
export type ResolveBrokerIdByMagicLinkTokenHash = (tokenHash: string) => Promise<string | null>;

export type CallbackRouteOptions = {
  resolveBrokerIdByMagicLinkTokenHash: ResolveBrokerIdByMagicLinkTokenHash;
  consumeMagicLinkToken: ConsumeMagicLinkTokenFn;
  createSession: CreateSessionFn;
  /** `env.DASHBOARD_BASE_URL` — no trailing slash (design.md D-G). */
  dashboardBaseUrl: string;
};

type RouteContext = Context<{ Variables: AppVariables }>;

export function registerCallbackRoute(
  app: Hono<{ Variables: AppVariables }>,
  { resolveBrokerIdByMagicLinkTokenHash, consumeMagicLinkToken, createSession, dashboardBaseUrl }: CallbackRouteOptions,
): void {
  function rejectRedirect(c: RouteContext) {
    // The raw token (if any) is deliberately never echoed into this
    // redirect's Location — see the module docstring.
    return c.redirect(`${dashboardBaseUrl}/login?error=invalid_token`, 302);
  }

  app.get("/auth/callback", async (c) => {
    const rawToken = c.req.query("token");
    if (!rawToken) {
      return rejectRedirect(c);
    }

    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const brokerId = await resolveBrokerIdByMagicLinkTokenHash(tokenHash);
    if (brokerId === null) {
      return rejectRedirect(c);
    }

    const consumeResult = await consumeMagicLinkToken({ brokerId, tokenHash });
    if (!consumeResult.ok) {
      return rejectRedirect(c);
    }

    const { rawSessionToken, rawCsrfToken } = await createSession({
      brokerId,
      brokerUserId: consumeResult.brokerUserId,
    });

    c.header("Set-Cookie", buildSessionCookieHeader(rawSessionToken), { append: true });
    c.header("Set-Cookie", buildCsrfCookieHeader(rawCsrfToken), { append: true });

    return c.redirect(`${dashboardBaseUrl}/`, 302);
  });
}
