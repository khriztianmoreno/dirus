import type { Hono } from "hono";
import type { AppVariables } from "../../app.js";

/**
 * `GET /auth/me` — added in `admin-dashboard` (C1) Phase 7 (task 7.4),
 * design.md D-G. Not part of Phases 1-6's own task list; design.md's File
 * Changes table already names `apps/api/src/routes/auth/{...,me}.ts` as
 * one file group, but no earlier phase's tasks (3.x/4.x) actually created
 * it — `src/routes/dashboard/RequireSession.tsx` (task 7.4) is the first
 * consumer that needs it, so it is added here, minimally.
 *
 * Mounted BEHIND `session-auth.ts` only (no `csrf-guard.ts` — this is a
 * `GET`, and csrf-guard.ts exempts safe methods itself, so mounting it
 * here would be inert). This route itself performs no auth check; it only
 * reads `c.var.session`, exactly as `session-auth.ts`'s own contract
 * states — a request without a well-formed, resolvable `dirus_session`
 * cookie never reaches this handler at all (401, empty body, from the
 * middleware).
 *
 * Response is deliberately minimal (task 7.4's brief: "basic session
 * info"): `ResolvedSession`'s own three identity fields, never the raw or
 * hashed session/CSRF token material (design.md D-D's `ResolvedSession`
 * type already excludes those).
 */
export function registerMeRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get("/auth/me", (c) => {
    const { brokerId, brokerUserId, role } = c.var.session;
    return c.json({ brokerId, brokerUserId, role }, 200);
  });
}
