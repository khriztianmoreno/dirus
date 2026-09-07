/**
 * `packages/integrations` — typed shell. `chatwoot.ts` (F2, Phase 5) is the
 * first typed client. `email/resend.ts` (`admin-dashboard` C1, task 3.1) is
 * the second. `meta-wa.ts`, `wompi.ts` land in later changes.
 */
export const PACKAGE_NAME = "@dirus/integrations" as const;

export * from "./chatwoot.js";
export * from "./email/resend.js";
