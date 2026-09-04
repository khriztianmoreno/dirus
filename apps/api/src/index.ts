import { serve } from "@hono/node-server";

import { createApp, type Ingest } from "./app.js";
import { env } from "./env.js";

/**
 * PLACEHOLDER — NOT the real ingest pipeline.
 *
 * `services/ingest-message.ts` (design D-2/D-3/D-5) does not exist yet; it
 * lands in Phase 5 of the `whatsapp-webhook-ingress` change. No route is
 * mounted in Phase 3 that calls `ingest` at all (only `GET /health`, which
 * never touches `c.var.ingest`), so this function is never actually
 * invoked at runtime today. It exists solely so `createApp`'s required
 * `ingest` parameter has something to receive at bootstrap. Task 3.9/5.22:
 * this is the one place `createApp` gets wired to a concrete `ingest` — when
 * Phase 5 lands, replace this constant with the real
 * `realIngestFromServicesIngestMessage` import from
 * `./services/ingest-message.js`. Do not implement real ingest logic here —
 * that belongs behind the `services/ingest-message.ts` boundary per D-5's
 * "no HTTP types cross this line" rule.
 */
const notYetImplementedIngest: Ingest = async () => {
  throw new Error(
    "Ingest pipeline not implemented yet (Phase 5 of whatsapp-webhook-ingress). " +
      "No route in Phase 3 calls this.",
  );
};

const app = createApp({ ingest: notYetImplementedIngest });

serve({ fetch: app.fetch, port: Number(env.PORT) });
