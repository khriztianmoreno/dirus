import { correctionRequestSchema } from "@dirus/schemas";

/**
 * `admin-dashboard` (C1) task 4.14, broker-auth spec "No session-protected
 * route schema declares a brokerId input field" (also a stated Success
 * Criteria checkbox). Every session-protected route's request-input Zod
 * schema MUST be registered here — `session-protected-schemas.test.ts`
 * iterates this registry and asserts none declares a `brokerId` field. This
 * is the mechanical enforcement point the task brief describes: a future
 * route author who "helpfully" adds a `brokerId` field to a request schema
 * is caught by this test, PROVIDED the route's schema is registered here.
 *
 * Empty in Phase 4 — this phase's only session-protected route is `POST
 * /auth/logout` (`routes/auth/logout.ts`), which accepts no body or query
 * input at all (it reads only the session cookie, already resolved by
 * `session-auth.ts`) and therefore has no Zod schema to register. Phase 5
 * (extraction review queue) and Phase 6 (product metrics) are the first
 * phases expected to add entries here as they add session-protected routes
 * with request bodies/query strings.
 *
 * Phase 5 registers `dashboard.reviewQueueCorrection`
 * (`correctionRequestSchema`, `POST /dashboard/review-queue/:id/correction`)
 * — its `GET /dashboard/review-queue` list endpoint takes no body/query
 * input at all (identical reasoning to `logout`), so it has no schema to
 * register either.
 *
 * Typed structurally (`{ shape?: unknown }`, `apps/api`'s own duck-typed
 * `SessionProtectedSchema`) rather than importing `z.ZodTypeAny` from
 * `"zod"` directly — `apps/api` has no direct `zod` dependency (only
 * `@dirus/schemas` does), and every Zod object schema exposes a `.shape`
 * property regardless of which package constructed it, so this stays
 * dependency-free while still checking the real shape.
 */
export type SessionProtectedSchema = { shape?: unknown };

export const SESSION_PROTECTED_INPUT_SCHEMAS: Record<string, SessionProtectedSchema> = {
  "dashboard.reviewQueueCorrection": correctionRequestSchema,
};

/** Reused by the test below and available to future phases' own route tests. */
export function schemaDeclaresBrokerIdField(schema: SessionProtectedSchema): boolean {
  const maybeShape = (schema as { shape?: unknown }).shape;
  if (!maybeShape || typeof maybeShape !== "object") {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(maybeShape, "brokerId");
}
