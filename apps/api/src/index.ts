import { serve } from "@hono/node-server";
import { brokerExists, resolveBrokerIdByWaPhoneNumberId } from "@dirus/db";
import { FIXED_ACKNOWLEDGEMENT_REPLY, createChatwootClient } from "@dirus/integrations";

import { createApp } from "./app.js";
import { env } from "./env.js";
import { ingestMessage } from "./services/ingest-message.js";
import { importPolicyRows } from "./services/import-policies-writer.js";

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
});

serve({ fetch: app.fetch, port: Number(env.PORT) });
