import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Proposal P2: a provisional shared-bearer-token auth for the `/admin`
 * prefix (currently only `POST /admin/policies/import`). It mirrors
 * `webhook-auth.ts`'s design D-4 pattern exactly: a fixed-length (>= 32
 * byte) server-configured secret, compared with `crypto.timingSafeEqual`,
 * 401 with an empty body on failure. It authenticates the CALLER (whoever
 * holds the shared secret), never the payload, and is replayable by anyone
 * who observes it. This is a compensating control, not a login system —
 * superseded the moment `admin-dashboard` (C1) ships real broker/admin
 * authentication.
 *
 * Unlike `webhook-auth.ts`, this middleware accepts the token from the
 * `X-Dirus-Admin-Token` header ONLY, with no URL path-segment fallback.
 * F2's webhook token also accepted a path segment because Chatwoot may only
 * permit configuring a URL — a constraint specific to that third-party
 * caller. An admin caller invoking this endpoint directly can always set a
 * header, so that fallback does not apply here and is deliberately not
 * copied (proposal P2).
 *
 * Constraint on the implementation (proposal P2, the one-file-swap
 * constraint): all auth logic lives in this one file. The route and any
 * future service code must contain no auth logic of their own, so that
 * replacing this middleware once C1 ships real authentication is a
 * one-file change.
 *
 * Mounted BEFORE any request-shape/size guard or the import service in the
 * route chain: a rejected request performs no parsing and writes no row,
 * because nothing downstream of a 401 response ever runs.
 */
export function createAdminAuthMiddleware(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const providedToken = c.req.header("X-Dirus-Admin-Token") ?? "";

    if (!constantTimeEquals(providedToken, expectedToken)) {
      // No detail in the body — an attacker probing the endpoint must not
      // learn why the request failed.
      return c.body(null, 401);
    }

    await next();
  };
}

/**
 * `crypto.timingSafeEqual` throws on mismatched buffer lengths, and even if
 * it did not, comparing buffers of different lengths "in constant time"
 * proves nothing — the LENGTH check itself is the thing that must not leak
 * timing information about what a valid length looks like. That is only
 * safe here because `expectedToken` is a fixed-length (>= 32 bytes,
 * proposal P2), server-configured secret, never derived from user input —
 * so the length check does not itself leak anything an attacker doesn't
 * already know from the deployed configuration.
 */
function constantTimeEquals(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}
