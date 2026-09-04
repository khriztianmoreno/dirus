import { Hono } from "hono";
import type { ChatwootMessageCreatedPayload } from "@dirus/schemas";

import { registerHealthRoute } from "./routes/health.js";
import { registerChatwootWebhookRoute } from "./routes/webhooks/chatwoot.js";
import type { ResolveBrokerId, TenantResolverVariables } from "./middleware/tenant-resolver.js";
import type { WebhookAuthVariables } from "./middleware/webhook-auth.js";

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
  WebhookAuthVariables & {
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
}: CreateAppOptions): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (c, next) => {
    c.set("ingest", ingest);
    await next();
  });

  registerHealthRoute(app);
  registerChatwootWebhookRoute(app, { webhookToken, resolveBrokerId, sendEcho });

  return app;
}
