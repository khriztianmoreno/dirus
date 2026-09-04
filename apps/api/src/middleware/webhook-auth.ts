import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export type WebhookAuthVariables = {
  /**
   * The raw request body text, read here (not `c.req.json()`) so that if
   * confirmation later shows Chatwoot supports HMAC signing (design D-4,
   * proposal O3), the upgrade — which needs the exact raw bytes, not a
   * re-serialized JSON.parse round trip — is local to this one middleware.
   * Downstream steps must read this instead of calling `c.req.text()`
   * again.
   */
  rawBody: string;
};

/**
 * Design D-4: a rotating shared-secret bearer credential — a compensating
 * control, **not** a signature. It authenticates the CALLER (whoever holds
 * the shared secret), never the PAYLOAD, and is replayable by anyone who
 * observes it. Chatwoot's own webhook-signing status is unconfirmed
 * (proposal O3); this is the stated fallback until that is confirmed. If
 * confirmation later shows HMAC support, the upgrade is local to this one
 * file — no route rewrite (design D-4).
 *
 * Accepted from the `X-Dirus-Webhook-Token` header when present, otherwise
 * from a URL path segment (`/webhooks/chatwoot/:token`), because Chatwoot
 * may only permit configuring a URL.
 *
 * Mounted BEFORE the tenant-resolver in the route chain (design D-4, spec
 * "Inbound Webhook Authentication"): a rejected request performs no
 * tenant-resolution lookup and writes no row, because nothing downstream
 * of a 401 response ever runs.
 */
export function createWebhookAuthMiddleware(
  expectedToken: string,
): MiddlewareHandler<{ Variables: WebhookAuthVariables }> {
  return async (c, next) => {
    const headerToken = c.req.header("X-Dirus-Webhook-Token");
    const pathToken = c.req.param("token");
    const providedToken = headerToken ?? pathToken ?? "";

    if (!constantTimeEquals(providedToken, expectedToken)) {
      // No detail in the body (design D-4) — an attacker probing the
      // endpoint must not learn why the request failed.
      return c.body(null, 401);
    }

    c.set("rawBody", await c.req.text());
    await next();
  };
}

/**
 * `crypto.timingSafeEqual` throws on mismatched buffer lengths, and even if
 * it did not, comparing buffers of different lengths "in constant time"
 * proves nothing — the LENGTH check itself is the thing that must not leak
 * timing information about what a valid length looks like. That is only
 * safe here because `expectedToken` is a fixed-length (>= 32 bytes, design
 * D-4), server-configured secret, never derived from user input — so the
 * length check does not itself leak anything an attacker doesn't already
 * know from the deployed configuration.
 */
function constantTimeEquals(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}
