import { createHash } from "node:crypto";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";

/**
 * `admin-dashboard` (C1) task 4.4, design.md D-D (exact type contract) and
 * D-B (opaque 256-bit session id, resolved server-side). Broker-auth spec
 * "brokerId Is Never Accepted From the Client" — this is the ONE middleware
 * that resolves `c.var.brokerId` for every session-protected route, and it
 * NEVER reads it from a path param, query string, body, or header.
 */
export type ResolvedSession = {
  brokerId: string;
  brokerUserId: string;
  /** O7: read, never enforced in v1. */
  role: string;
  csrfTokenHash: string;
};

/** Injected exactly like `ResolveBrokerId` (`tenant-resolver.ts`) — never imports `@dirus/db`. */
export type ResolveSession = (sessionTokenHash: string) => Promise<ResolvedSession | null>;

export type SessionAuthVariables = {
  /**
   * SAME context key as `TenantResolverVariables.brokerId` (design.md D-D) —
   * deliberately not a distinct `sessionBrokerId` key. Hono types context
   * variables once per app instance, so both middlewares already share one
   * map, and the key means exactly the same thing in both: the
   * server-resolved tenant for this request, never client input. No route
   * mounts both middlewares.
   */
  brokerId: string;
  session: ResolvedSession;
};

/** `dirus_session` cookie name (design.md D-B). */
export const SESSION_COOKIE_NAME = "dirus_session";

/**
 * 32 raw CSPRNG bytes, base64url-encoded without padding, is always exactly
 * 43 characters (`create-session.ts`'s `randomBytes(32).toString("base64url")`).
 * Any other length is definitionally not a value this system issued.
 */
const SESSION_COOKIE_LENGTH = 43;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** SHA-256 hex digest of the raw session cookie value — never the raw value itself is passed to `resolveSession`. */
export function hashSessionToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isWellFormedSessionCookie(raw: string): boolean {
  return raw.length === SESSION_COOKIE_LENGTH && BASE64URL_PATTERN.test(raw);
}

/**
 * The middleware, in order (design.md D-D): shape-check the cookie (length +
 * base64url charset) -> reject `401` with an empty body WITHOUT calling
 * `resolveSession` at all (a malformed cookie can never hash to a real
 * session, so there is no reason to spend a DB round trip on it) -> `sha256`
 * -> `resolveSession` -> `null` result also rejects `401` empty body,
 * mirroring `webhook-auth.ts`'s convention -> `c.set("brokerId", …)`,
 * `c.set("session", …)`.
 *
 * Takes `resolveSession` as an injected parameter (never imports `@dirus/db`
 * directly), mirroring `tenant-resolver.ts`'s `ResolveBrokerId` convention,
 * so this middleware stays offline-testable with a fake. Only
 * `apps/api/src/index.ts` wires in the real implementation
 * (`services/auth/resolve-session.ts`, task 4.12).
 */
export function createSessionAuthMiddleware(
  resolveSession: ResolveSession,
): MiddlewareHandler<{ Variables: SessionAuthVariables }> {
  return async (c, next) => {
    const raw = getCookie(c, SESSION_COOKIE_NAME);

    if (!raw || !isWellFormedSessionCookie(raw)) {
      return c.body(null, 401);
    }

    const session = await resolveSession(hashSessionToken(raw));

    if (session === null) {
      return c.body(null, 401);
    }

    c.set("brokerId", session.brokerId);
    c.set("session", session);
    await next();
  };
}
