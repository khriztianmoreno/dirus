import { Hono } from "hono";
import type { ChatwootMessageCreatedPayload } from "@dirus/schemas";

import { registerHealthRoute } from "./routes/health.js";
import { registerChatwootWebhookRoute } from "./routes/webhooks/chatwoot.js";
import { registerAdminPoliciesImportRoute, type ImportPolicyRowsFn } from "./routes/admin/policies-import.js";
import {
  registerMagicLinkRoute,
  type IssueMagicLinkTokenFn,
  type ResolveBrokerIdByEmail,
  type SendMagicLinkFn,
} from "./routes/auth/magic-link.js";
import { registerCallbackRoute, type ResolveBrokerIdByMagicLinkTokenHash } from "./routes/auth/callback.js";
import { registerLogoutRoute } from "./routes/auth/logout.js";
import { registerMeRoute } from "./routes/auth/me.js";
import {
  registerReviewQueueRoute,
  type CorrectExtractionFn,
  type NeedsReviewQueueFn,
} from "./routes/dashboard/review-queue.js";
import { registerMetricsRoute, type MetricsRouteOptions } from "./routes/dashboard/metrics.js";
import { createSessionAuthMiddleware, type ResolveSession, type SessionAuthVariables } from "./middleware/session-auth.js";
import { createCsrfGuardMiddleware } from "./middleware/csrf-guard.js";
import type { ResolveBrokerId, TenantResolverVariables } from "./middleware/tenant-resolver.js";
import type { WebhookAuthVariables } from "./middleware/webhook-auth.js";
import type { ResolveBrokerExists } from "./services/import-policies.js";
import type { ConsumeMagicLinkTokenFn } from "./services/auth/consume-magic-link.js";
import type { CreateSessionFn } from "./services/auth/session-cookies.js";
import type { RevokeSessionFn } from "./services/auth/revoke-session.js";

/**
 * `services/ingest-message.ts` (design D-2/D-3/D-5, "no HTTP types cross
 * this line") is the real implementation, wired in only by `index.ts`
 * (Phase 5, task 5.22). `payload` is typed as the parsed Chatwoot stage-2
 * schema, never a raw/HTTP-shaped value — the route parses before calling
 * this.
 */
export type Ingest = (
  brokerId: string,
  payload: ChatwootMessageCreatedPayload,
) => Promise<{ deduplicated: boolean }>;

/**
 * Sends the fixed acknowledgement reply (design D-5, spec "Fixed Echo
 * Reply"). Injected so the route stays offline-testable with a fake — only
 * `index.ts` wires in `packages/integrations/src/chatwoot.ts`'s real
 * client.
 */
export type SendEcho = (payload: ChatwootMessageCreatedPayload) => Promise<void>;

/**
 * A single, app-wide context-variable map (Hono types context variables
 * per app instance, not per route). Includes the health/global `ingest`
 * variable plus every variable the Chatwoot webhook route's middleware
 * chain sets (`webhook-auth.ts`'s `rawBody`, `tenant-resolver.ts`'s
 * `resolutionKey`/`brokerId`, and the route's own parsed `payload`) — only
 * that one route actually sets/reads the latter group, but Hono needs one
 * shared `Variables` type for the whole app.
 */
export type AppVariables = TenantResolverVariables &
  WebhookAuthVariables &
  SessionAuthVariables & {
    ingest: Ingest;
    payload: ChatwootMessageCreatedPayload;
  };

export type CreateAppOptions = {
  ingest: Ingest;
  /**
   * Design D-1/D-5: resolves a `wa_phone_number_id`-shaped key to a
   * `broker_id`. Only `index.ts` wires in the real
   * `resolveBrokerIdByWaPhoneNumberId` export from `@dirus/db` — everything
   * else (including this factory's own tests) injects a fake, so
   * `@dirus/db` stays unreachable from any offline test's import graph.
   */
  resolveBrokerId: ResolveBrokerId;
  /**
   * Design D-4: the `CHATWOOT_WEBHOOK_TOKEN` bearer credential — a
   * compensating control, not a signature. Passed as a plain string rather
   * than read from `env.ts` inside this factory, so tests can set an
   * arbitrary value without needing every other `apps/api` env var
   * present.
   */
  webhookToken: string;
  sendEcho: SendEcho;
  /** Phase 6 (`policy-bulk-import`): the provisional shared-bearer-token secret for `/admin/policies/import` (`env.ADMIN_API_TOKEN`). */
  adminToken: string;
  /**
   * Phase 6: injected so `apps/api/src/routes/admin/policies-import.ts`
   * stays offline-testable with a fake — only `index.ts` wires in the real
   * `brokerExists` export from `@dirus/db`.
   */
  resolveBrokerExists: ResolveBrokerExists;
  /**
   * Phase 6: injected so the admin import route never imports
   * `import-policies-writer.ts` (which pulls in `@dirus/db`) as a value —
   * only `index.ts` wires in the real `importPolicyRows` export.
   */
  importPolicyRows: ImportPolicyRowsFn;
  /**
   * `admin-dashboard` (C1) Phase 3, design.md D-A/D-C: resolves an `email`
   * to a `broker_id` via `@dirus/db`'s `resolveBrokerIdByEmail`. Only
   * `index.ts` wires in the real export — everything else, including this
   * factory's own tests, injects a fake.
   */
  resolveBrokerIdByEmail: ResolveBrokerIdByEmail;
  /**
   * Phase 3, design.md D-A/D-C: the whole "withBrokerContext(insert
   * magic_link_tokens) (COMMIT)" step, opaque to the route. Only
   * `index.ts` wires in `services/auth/issue-magic-link.ts`'s real
   * `issueMagicLinkToken` — never imported as a value by the route itself,
   * mirroring `importPolicyRows`'s convention.
   */
  issueMagicLinkToken: IssueMagicLinkTokenFn;
  /**
   * Phase 3, O3 (proposal Round 2: "no architectural stakes"): dispatches
   * the magic-link email. Only `index.ts` wires in
   * `packages/integrations/src/email/resend.ts`'s real client.
   */
  sendMagicLink: SendMagicLinkFn;
  /** `env.DASHBOARD_BASE_URL` (design.md D-G) — no trailing slash. */
  dashboardBaseUrl: string;
  /**
   * Phase 3, design.md D-A: resolves a magic-link token hash to a
   * `broker_id` via `@dirus/db`'s `resolveBrokerIdByMagicLinkTokenHash`.
   */
  resolveBrokerIdByMagicLinkTokenHash: ResolveBrokerIdByMagicLinkTokenHash;
  /**
   * Phase 3, design.md D-A: the atomic single-use + expiry UPDATE (task
   * 3.15). Only `index.ts` wires in `services/auth/consume-magic-link.ts`'s
   * real `consumeMagicLinkToken` — never imported as a value by the route.
   */
  consumeMagicLinkToken: ConsumeMagicLinkTokenFn;
  /**
   * Phase 3, design.md D-B (task 3.18). Only `index.ts` wires in
   * `services/auth/create-session.ts`'s real `createSession` — never
   * imported as a value by the route (which imports the cookie builders
   * from `services/auth/session-cookies.ts` instead, a `@dirus/db`-free
   * module, per that file's own docstring).
   */
  createSession: CreateSessionFn;
  /**
   * Phase 4, design.md D-D (task 4.12). Resolves a session cookie hash to a
   * `ResolvedSession`, or `null`. Only `index.ts` wires in the real
   * `services/auth/resolve-session.ts` export — everything else, including
   * this factory's own tests, injects a fake, mirroring `resolveBrokerId`'s
   * convention.
   */
  resolveSession: ResolveSession;
  /**
   * Phase 4, broker-auth spec "Logout Invalidates the Session" (task 4.12).
   * Only `index.ts` wires in `services/auth/revoke-session.ts`'s real
   * `revokeSession` — never imported as a value by the route.
   */
  revokeSession: RevokeSessionFn;
  /**
   * Phase 5, design.md D-E, extraction-review spec "Review Queue Lists
   * Only Flagged Extractions". Only `index.ts` wires in
   * `services/queries/needs-review-queue.ts`'s real `needsReviewQueue` —
   * never imported as a value by the route (which imports its
   * `ReviewQueueRow` type only), mirroring `importPolicyRows`'s
   * convention.
   */
  needsReviewQueue: NeedsReviewQueueFn;
  /**
   * Phase 5, extraction-review spec "Reviewer Correction Writes Back
   * correctedOutput and correctedBy". Only `index.ts` wires in
   * `services/queries/correct-extraction.ts`'s real `correctExtraction`.
   */
  correctExtraction: CorrectExtractionFn;
  /**
   * Phase 6, design.md D-F, product-metrics spec (all requirements). Six
   * `(brokerId) => Promise<MetricResult<T>>` functions, one per §12
   * metric — `index.ts` wires each real one as
   * `(brokerId) => withBrokerContext(brokerId, <metric fn>)`, per
   * `routes/dashboard/metrics.ts`'s own docstring on why the reentrancy
   * shape differs from every other injected dependency above.
   */
  metrics: MetricsRouteOptions;
};

/**
 * `createApp({ ingest, resolveBrokerId, webhookToken, sendEcho })` — a
 * factory, not a module-level singleton (design D-5). `@dirus/db` throws at
 * import time when `DATABASE_URL` is absent, so anything that transitively
 * imports it cannot be loaded in a test without a live database. Taking
 * every `@dirus/db`/`@dirus/integrations`-shaped dependency as an injected
 * parameter is what lets this module — and every route mounted on it —
 * stay importable and exercisable in tests with fakes, with zero
 * `@dirus/db` import reachable from the test's import graph. Only
 * `index.ts` wires in the real implementations (Phase 5, task 5.22).
 *
 * `ingest` is threaded into `c.var.ingest` so the webhook route reads it
 * from context rather than a closure captured at route-registration time
 * — this mirrors `middleware/tenant-resolver.ts`'s `c.var.brokerId`
 * convention. `resolveBrokerId`, `webhookToken`, and `sendEcho` are passed
 * directly to `registerChatwootWebhookRoute`, since only that one route
 * needs them (unlike `ingest`, which was already established as a
 * context variable in Phase 3 before this route existed).
 */
export function createApp({
  ingest,
  resolveBrokerId,
  webhookToken,
  sendEcho,
  adminToken,
  resolveBrokerExists,
  importPolicyRows,
  resolveBrokerIdByEmail,
  issueMagicLinkToken,
  sendMagicLink,
  dashboardBaseUrl,
  resolveBrokerIdByMagicLinkTokenHash,
  consumeMagicLinkToken,
  createSession,
  resolveSession,
  revokeSession,
  needsReviewQueue,
  correctExtraction,
  metrics,
}: CreateAppOptions): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (c, next) => {
    c.set("ingest", ingest);
    await next();
  });

  registerHealthRoute(app);
  registerChatwootWebhookRoute(app, { webhookToken, resolveBrokerId, sendEcho });
  registerAdminPoliciesImportRoute(app, { adminToken, resolveBrokerExists, importPolicyRows });
  registerMagicLinkRoute(app, { resolveBrokerIdByEmail, issueMagicLinkToken, sendMagicLink, dashboardBaseUrl });
  registerCallbackRoute(app, {
    resolveBrokerIdByMagicLinkTokenHash,
    consumeMagicLinkToken,
    createSession,
    dashboardBaseUrl,
  });

  // Phase 4 (design.md D-D): session-auth resolves `c.var.brokerId`/
  // `c.var.session` for every session-protected route; csrf-guard is
  // mounted AFTER it (reads `c.var.session.csrfTokenHash`) and applies only
  // to mutating requests (it exempts GET/HEAD itself, design.md D-B).
  // Phase 5 is the first phase to add dashboard data routes under these
  // same two middlewares (`/dashboard/*`), alongside the existing
  // `/auth/logout` scope — one `app.use(...)` per path prefix, both
  // middlewares mounted BEFORE the routes that read `c.var.brokerId`/
  // `c.var.session`.
  app.use("/auth/logout", createSessionAuthMiddleware(resolveSession), createCsrfGuardMiddleware());
  registerLogoutRoute(app, { revokeSession });

  // Phase 7, task 7.4: GET-only, so mounted behind session-auth.ts alone —
  // csrf-guard.ts exempts safe methods itself, and this route never
  // mutates anything.
  app.use("/auth/me", createSessionAuthMiddleware(resolveSession));
  registerMeRoute(app);

  app.use("/dashboard/*", createSessionAuthMiddleware(resolveSession), createCsrfGuardMiddleware());
  registerReviewQueueRoute(app, { needsReviewQueue, correctExtraction });
  registerMetricsRoute(app, metrics);

  return app;
}
