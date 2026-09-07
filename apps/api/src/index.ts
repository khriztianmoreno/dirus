import { serve } from "@hono/node-server";
import {
  brokerExists,
  resolveBrokerIdByEmail,
  resolveBrokerIdByMagicLinkTokenHash,
  resolveBrokerIdByWaPhoneNumberId,
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

/**
 * Real bootstrap wiring (task 5.22, design D-5). This is the ONE place
 * `createApp`'s injected dependencies get bound to their real
 * implementations:
 *
 *   - `ingest`     -> `services/ingest-message.ts` (design D-2/D-3, "the one
 *                      place Phase 1-2's proven primitives get exercised
 *                      together"). Replaces Phase 3's placeholder.
 *   - `resolveBrokerId` -> `@dirus/db`'s `resolveBrokerIdByWaPhoneNumberId`
 *                      (design D-1/D-7).
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
  resolveBrokerId: resolveBrokerIdByWaPhoneNumberId,
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
});

serve({ fetch: app.fetch, port: Number(env.PORT) });
