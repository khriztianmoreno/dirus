import { serve } from "@hono/node-server";
import {
  brokerExists,
  resolveBrokerIdByChatwootAccountId,
  resolveBrokerIdByEmail,
  resolveBrokerIdByMagicLinkTokenHash,
  withBrokerContext,
} from "@dirus/db";
import { FIXED_ACKNOWLEDGEMENT_REPLY, createChatwootClient, createResendEmailClient } from "@dirus/integrations";

import { createApp } from "./app.js";
import { env } from "./env.js";
import { ingestMessage } from "./services/ingest-message.js";
import { importPolicyRows } from "./services/import-policies-writer.js";
import { issueMagicLinkToken } from "./services/auth/issue-magic-link.js";
import { consumeMagicLinkToken } from "./services/auth/consume-magic-link.js";
import { createSession } from "./services/auth/create-session.js";
import { resolveSession } from "./services/auth/resolve-session.js";
import { revokeSession } from "./services/auth/revoke-session.js";
import { needsReviewQueue } from "./services/queries/needs-review-queue.js";
import { correctExtraction } from "./services/queries/correct-extraction.js";
import { copilotShare } from "./services/metrics/copilot-share.js";
import { renewalStatus } from "./services/metrics/renewal-status.js";
import { needsReviewRate } from "./services/metrics/needs-review-rate.js";
import { conversationStatusSnapshot } from "./services/metrics/conversation-status-snapshot.js";
import { timeToFirstRenewal } from "./services/metrics/time-to-first-renewal.js";
import { costMetric } from "./services/metrics/cost.js";

/**
 * Real bootstrap wiring (task 5.22, design D-5). This is the ONE place
 * `createApp`'s injected dependencies get bound to their real
 * implementations:
 *
 *   - `ingest`     -> `services/ingest-message.ts` (design D-2/D-3, "the one
 *                      place Phase 1-2's proven primitives get exercised
 *                      together"). Replaces Phase 3's placeholder.
 *   - `resolveBrokerId` -> `@dirus/db`'s `resolveBrokerIdByChatwootAccountId`
 *                      (design D-1/D-7, corrected by fix-chatwoot-tenant-resolution
 *                      design D-A/D-E).
 *   - `sendEcho`    -> `packages/integrations/src/chatwoot.ts`'s real
 *                      client, sending the fixed acknowledgement reply
 *                      (design D-5, spec "Fixed Echo Reply").
 *   - `webhookToken` -> `env.CHATWOOT_WEBHOOK_TOKEN` (design D-4).
 *   - `adminToken`  -> `env.ADMIN_API_TOKEN` (`policy-bulk-import` proposal P2).
 *   - `resolveBrokerExists` -> `@dirus/db`'s `brokerExists` (`policy-bulk-import`
 *                      task 6.4).
 *   - `importPolicyRows` -> `services/import-policies-writer.ts`'s real
 *                      `withBrokerContext`-backed per-row loop
 *                      (`policy-bulk-import` Phase 5, wired here per task 6.4).
 *
 * Nothing above this file's own module scope imports `@dirus/db` — that is
 * exactly why `app.ts`/the route/middleware files stay offline-testable
 * (design D-5): this is the only module in `apps/api/src` that imports
 * `@dirus/db` at all (directly, or transitively via
 * `import-policies-writer.ts`).
 */
const chatwootClient = createChatwootClient({
  baseUrl: env.CHATWOOT_BASE_URL,
  apiAccessToken: env.CHATWOOT_API_ACCESS_TOKEN,
  accountId: env.CHATWOOT_ACCOUNT_ID,
});

const resendEmailClient = createResendEmailClient({
  apiKey: env.EMAIL_API_KEY,
  fromAddress: env.EMAIL_FROM_ADDRESS,
});

const app = createApp({
  ingest: ingestMessage,
  resolveBrokerId: resolveBrokerIdByChatwootAccountId,
  webhookToken: env.CHATWOOT_WEBHOOK_TOKEN,
  sendEcho: async (payload) => {
    await chatwootClient.sendReply({
      conversationId: payload.conversation.id,
      content: FIXED_ACKNOWLEDGEMENT_REPLY,
    });
  },
  adminToken: env.ADMIN_API_TOKEN,
  resolveBrokerExists: brokerExists,
  importPolicyRows,
  // admin-dashboard (C1) Phase 3 (design.md D-A/D-C/D-B).
  resolveBrokerIdByEmail,
  issueMagicLinkToken,
  sendMagicLink: resendEmailClient.sendMagicLink,
  dashboardBaseUrl: env.DASHBOARD_BASE_URL,
  resolveBrokerIdByMagicLinkTokenHash,
  consumeMagicLinkToken,
  createSession,
  // admin-dashboard (C1) Phase 4 (design.md D-D, task 4.12).
  resolveSession,
  revokeSession,
  // admin-dashboard (C1) Phase 5 (design.md D-E, tasks 5.8/5.12).
  needsReviewQueue,
  correctExtraction,
  // admin-dashboard (C1) Phase 6 (design.md D-F, task 6.16). Each real
  // metric function is `(tx: TenantDb) => Promise<MetricResult<T>>` and
  // never opens its own `withBrokerContext` (routes/dashboard/metrics.ts's
  // own docstring) — this IS "the caller" D-F refers to: a one-line
  // partial application of `withBrokerContext` itself, since each metric
  // function's signature already matches its `fn` parameter exactly.
  // `cost` is wired with `langfuseCostSource: null` — no real Langfuse
  // HTTP client is built in this phase's task list (tasks 6.1-6.17 name
  // only `cost.ts` behind the `LangfuseCostSource` interface); `null` is
  // exactly the "no Langfuse client configured" state the spec's own
  // "Cost Metric Discloses Deferred State" scenario describes, so this is
  // the correct production wiring for right now, not a stub left unwired
  // by omission.
  metrics: {
    copilotShare: (brokerId) => withBrokerContext(brokerId, copilotShare),
    renewalStatus: (brokerId) => withBrokerContext(brokerId, renewalStatus),
    needsReviewRate: (brokerId) => withBrokerContext(brokerId, needsReviewRate),
    conversationStatusSnapshot: (brokerId) => withBrokerContext(brokerId, conversationStatusSnapshot),
    timeToFirstRenewal: (brokerId) => withBrokerContext(brokerId, timeToFirstRenewal),
    cost: () => costMetric(null),
  },
});

serve({ fetch: app.fetch, port: Number(env.PORT) });
