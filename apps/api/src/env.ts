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
};
