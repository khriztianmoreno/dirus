import type { Context, Hono } from "hono";
import {
  chatwootMessageCreatedPayloadSchema,
  chatwootWebhookEnvelopeSchema,
  extractResolutionKey,
  isIgnorableChatwootEvent,
} from "@dirus/schemas";

import type { AppVariables, SendEcho } from "../../app.js";
import { createWebhookAuthMiddleware } from "../../middleware/webhook-auth.js";
import { createTenantResolverMiddleware, type ResolveBrokerId } from "../../middleware/tenant-resolver.js";

export type ChatwootWebhookRouteOptions = {
  webhookToken: string;
  resolveBrokerId: ResolveBrokerId;
  sendEcho: SendEcho;
};

type RouteContext = Context<{ Variables: AppVariables }>;

/**
 * `POST /webhooks/chatwoot` and `POST /webhooks/chatwoot/:token` (design
 * D-4: the token may arrive via header or URL path segment; both routes
 * share the exact same handler chain).
 *
 * Ordering follows design's Technical Approach verbatim: "authenticate →
 * parse → resolve tenant → transaction → commit → echo. No step can be
 * reached by skipping the one before it." Concretely:
 *
 *   1. `webhook-auth` middleware — 401 short-circuits before anything else
 *      runs (spec "Inbound Webhook Authentication").
 *   2. Stage-1 envelope parse (design D-6) — a non-`message_created` /
 *      non-`incoming` event is ACKNOWLEDGED (200 `{ ignored: true }`, no
 *      database access whatsoever), never treated as an error, because
 *      Chatwoot retries non-2xx responses.
 *   3. Stage-2 payload parse (design D-6) — a malformed payload is
 *      rejected 400.
 *   4. `extractResolutionKey` (design D-6, the single isolated point of
 *      contact with "which field carries the key") then the
 *      tenant-resolver middleware (design D-1) — an unknown key rejects,
 *      never guesses/defaults a broker.
 *   5. `ingest(brokerId, payload)` — the D-2/D-3 transaction, entirely
 *      behind `services/ingest-message.ts`'s boundary (no HTTP types cross
 *      that line). A persistence failure (thrown/rejected) never reaches
 *      the echo step (spec "Reply is not sent when persistence fails").
 *   6. Echo — sent strictly AFTER `ingest` resolves successfully, and only
 *      when `deduplicated` is `false` (design D-3's "losing side": the
 *      transaction still commits on a duplicate, but no second
 *      acknowledgement is sent).
 */
export function registerChatwootWebhookRoute(
  app: Hono<{ Variables: AppVariables }>,
  { webhookToken, resolveBrokerId, sendEcho }: ChatwootWebhookRouteOptions,
): void {
  const authMiddleware = createWebhookAuthMiddleware(webhookToken);
  const tenantResolverMiddleware = createTenantResolverMiddleware(resolveBrokerId);

  async function parseAndExtractResolutionKey(c: RouteContext, next: () => Promise<void>) {
    let json: unknown;
    try {
      json = JSON.parse(c.var.rawBody);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const envelopeResult = chatwootWebhookEnvelopeSchema.safeParse(json);
    if (!envelopeResult.success || isIgnorableChatwootEvent(envelopeResult.data)) {
      // Design D-6: 200, not 4xx — Chatwoot retries non-2xx responses, and
      // an event we deliberately ignore is not an error. No database
      // access happens on this path.
      return c.json({ ignored: true }, 200);
    }

    const payloadResult = chatwootMessageCreatedPayloadSchema.safeParse(json);
    if (!payloadResult.success) {
      return c.json({ error: "invalid payload" }, 400);
    }

    c.set("payload", payloadResult.data);
    c.set("resolutionKey", extractResolutionKey(payloadResult.data));
    await next();
  }

  async function ingestAndEcho(c: RouteContext) {
    const { payload, brokerId, ingest } = c.var;

    let result: { deduplicated: boolean };
    try {
      result = await ingest(brokerId, payload);
    } catch {
      // Persistence failed before commit — no echo is sent (spec "Reply is
      // not sent when persistence fails"). No detail in the body,
      // mirroring the auth middleware's stance on not leaking internals.
      return c.body(null, 500);
    }

    // Design D-3's "losing side": the transaction already committed (steps
    // 1-3 are idempotent), so a 2xx is mandatory — but no echo for a
    // message this endpoint has already acknowledged once.
    if (!result.deduplicated) {
      await sendEcho(payload);
    }

    return c.json(result, 200);
  }

  app.post("/webhooks/chatwoot", authMiddleware, parseAndExtractResolutionKey, tenantResolverMiddleware, ingestAndEcho);
  app.post(
    "/webhooks/chatwoot/:token",
    authMiddleware,
    parseAndExtractResolutionKey,
    tenantResolverMiddleware,
    ingestAndEcho,
  );
}
