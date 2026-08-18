/**
 * `apps/api` — empty typed shell (workspace-foundation: Apps are empty typed
 * shells). No Hono server, no `/health` route: webhook/admin REST wiring is
 * deferred to the `whatsapp-webhook-ingress` change (F2).
 */
export const APP_NAME = "@dirus/api" as const;
