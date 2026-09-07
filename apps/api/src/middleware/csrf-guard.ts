import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { ResolvedSession } from "./session-auth.js";

/**
 * `admin-dashboard` (C1) task 4.8, design.md D-B: "session-bound
 * double-submit" CSRF. Mounted AFTER `session-auth.ts` (reads
 * `c.var.session.csrfTokenHash`, set by that middleware), only on mutating
 * routes — a separate middleware, not folded into `session-auth.ts`, per
 * design.md D-D's explicit statement.
 *
 * Safe methods (`GET`/`HEAD`) are exempt (design.md D-B) — and consequently
 * no `GET` endpoint in this change may mutate. `POST`/`PATCH`/`PUT`/`DELETE`
 * must present the raw CSRF value (echoed by the SPA from the non-`HttpOnly`
 * `dirus_csrf` cookie) in the `X-Dirus-CSRF` header; the server hashes it
 * and compares against `session.csrfTokenHash` with
 * `crypto.timingSafeEqual`, mirroring `admin-auth.ts`'s `constantTimeEquals`
 * helper (length check first — `timingSafeEqual` throws on mismatched
 * buffer lengths, and even if it did not, comparing different-length
 * buffers "in constant time" proves nothing) — never a plain `===` string
 * comparison, which would reintroduce the timing side-channel design D-B
 * explicitly closed.
 */
export const CSRF_HEADER_NAME = "X-Dirus-CSRF";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function hashCsrfToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function constantTimeEquals(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}

export function createCsrfGuardMiddleware(): MiddlewareHandler<{ Variables: { session: ResolvedSession } }> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    const header = c.req.header(CSRF_HEADER_NAME) ?? "";
    const providedHash = hashCsrfToken(header);

    if (!constantTimeEquals(providedHash, c.var.session.csrfTokenHash)) {
      // No detail in the body — mirrors webhook-auth.ts/admin-auth.ts: an
      // attacker probing the endpoint must not learn why the request failed.
      return c.body(null, 403);
    }

    await next();
  };
}
