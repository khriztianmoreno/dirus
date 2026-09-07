import { createHash, randomBytes } from "node:crypto";
import { schema, withBrokerContext } from "@dirus/db";
import type { CreateSessionFn } from "./session-cookies.js";

/**
 * `admin-dashboard` (C1) task 3.18, design.md D-B: on a successful
 * callback, generate the opaque 32-byte session id and the independent
 * 32-byte CSRF value, SHA-256 hash both, and persist a `sessions` row with
 * `idle_expires_at = now() + 7 days`, returning the RAW values so the
 * route can set the two cookies (`./session-cookies.ts`'s
 * `buildSessionCookieHeader`/`buildCsrfCookieHeader`).
 *
 * This file is intentionally `@dirus/db`-importing — `routes/auth/
 * callback.ts` takes a `CreateSessionFn` injected parameter (imported as a
 * TYPE from `./session-cookies.ts`, never from here) instead of importing
 * this module as a value, mirroring `import-policies-writer.ts`'s
 * convention. Only `apps/api/src/index.ts` wires in the function below.
 *
 * Called strictly AFTER `consume-magic-link.ts`'s own `withBrokerContext`
 * call has already resolved (never nested inside it) — opening a SECOND,
 * independent `withBrokerContext` here is fine (it is not a nested/
 * reentrant call, just a second sequential one), per `tenant.ts`'s
 * reentrancy guard, which only rejects a call still in progress on the
 * same async context.
 */

const SESSION_IDLE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Real implementation (task 3.18), wired in only by `apps/api/src/index.ts`. */
export const createSession: CreateSessionFn = async ({ brokerId, brokerUserId }) => {
  const rawSessionToken = randomBytes(32).toString("base64url");
  const rawCsrfToken = randomBytes(32).toString("base64url");
  const idleExpiresAt = new Date(Date.now() + SESSION_IDLE_EXPIRY_MS);

  await withBrokerContext(brokerId, async (tx) => {
    await tx.insert(schema.sessions).values({
      brokerId,
      brokerUserId,
      sessionTokenHash: sha256Hex(rawSessionToken),
      csrfTokenHash: sha256Hex(rawCsrfToken),
      idleExpiresAt,
    });
  });

  return { rawSessionToken, rawCsrfToken };
};
