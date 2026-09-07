/**
 * `apps/api`'s own required environment variables (design D-5).
 *
 * Mirrors the house pattern exactly:
 * `packages/db/src/internal/client.ts`'s hand-rolled `readRequired(name)`
 * that throws at **import time**, naming the missing variable — not a lazy
 * getter, not a Zod schema.
 *
 * Deliberately does NOT re-validate `DATABASE_URL`: `@dirus/db` already
 * fails loud on it at its own import time (`readDatabaseUrl` in
 * `packages/db/src/internal/client.ts`), and a second copy of that check
 * here would only invite the two to drift (design D-5). This module has no
 * dependency, direct or transitive, on `@dirus/db`.
 */
function readRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (see .env.example). Refusing to start without it.`);
  }
  return value;
}

export const env = {
  CHATWOOT_WEBHOOK_TOKEN: readRequired("CHATWOOT_WEBHOOK_TOKEN"),
  CHATWOOT_BASE_URL: readRequired("CHATWOOT_BASE_URL"),
  CHATWOOT_API_ACCESS_TOKEN: readRequired("CHATWOOT_API_ACCESS_TOKEN"),
  CHATWOOT_ACCOUNT_ID: readRequired("CHATWOOT_ACCOUNT_ID"),
  PORT: readRequired("PORT"),
  // A1 phase 3 (proposal P2): provisional shared-bearer-token auth for
  // `/admin/policies/import`, superseded once `admin-dashboard` (C1) ships
  // real broker/admin authentication. See middleware/admin-auth.ts.
  ADMIN_API_TOKEN: readRequired("ADMIN_API_TOKEN"),
  // admin-dashboard (C1) task 3.2/3.3, design.md D-C/D-H: the magic-link
  // request route's email dispatch (packages/integrations/src/email/resend.ts)
  // and the callback URL it builds.
  EMAIL_API_KEY: readRequired("EMAIL_API_KEY"),
  EMAIL_FROM_ADDRESS: readRequired("EMAIL_FROM_ADDRESS"),
  // Base URL (no trailing slash) the magic-link route builds the callback
  // link against, e.g. "https://app.dirus.io" (design.md D-G: the SPA's
  // own origin, since prod is same-origin per Caddy's reverse proxy).
  DASHBOARD_BASE_URL: readRequired("DASHBOARD_BASE_URL"),
};
