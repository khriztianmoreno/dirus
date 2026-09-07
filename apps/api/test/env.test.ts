import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// design D-5: `apps/api/src/env.ts` mirrors `packages/db/src/internal/client.ts`'s
// `readRequired(name)` fail-loud-at-import pattern, but only for apps/api's own
// vars. It deliberately does NOT re-validate DATABASE_URL — that's @dirus/db's job
// already — so this file must stay loadable with zero database env vars set.
const REQUIRED_VARS = [
  "CHATWOOT_WEBHOOK_TOKEN",
  "CHATWOOT_BASE_URL",
  "CHATWOOT_API_ACCESS_TOKEN",
  "CHATWOOT_ACCOUNT_ID",
  "PORT",
  // A1 phase 3: provisional admin-token auth for /admin/policies/import
  // (proposal P2), same readRequired fail-loud-at-import pattern.
  "ADMIN_API_TOKEN",
  // admin-dashboard (C1) task 3.2, design.md D-C/D-H: the magic-link email
  // send needs the Resend API key, the "From" address, and the base URL
  // used to build the callback link — all fail-loud-at-import, same pattern.
  "EMAIL_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "DASHBOARD_BASE_URL",
] as const;

describe("apps/api/src/env.ts (design D-5: fail-loud at import, apps/api's own vars only)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const key of REQUIRED_VARS) delete process.env[key];
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it.each(REQUIRED_VARS)("throws at import time naming the missing variable: %s", async (missing) => {
    for (const key of REQUIRED_VARS) {
      if (key !== missing) process.env[key] = "test-value";
    }

    await expect(import("../src/env.js")).rejects.toThrow(new RegExp(missing));
  });

  it("succeeds when all of apps/api's own required vars are present", async () => {
    for (const key of REQUIRED_VARS) process.env[key] = "test-value";

    const mod = await import("../src/env.js");

    expect(mod.env.PORT).toBe("test-value");
    expect(mod.env.CHATWOOT_WEBHOOK_TOKEN).toBe("test-value");
  });

  // The load-bearing assertion for design D-5's "deliberately does not
  // re-validate DATABASE_URL" statement: this module must load fine with
  // DATABASE_URL absent, proving env.ts has no dependency — direct or
  // transitive — on @dirus/db's own DATABASE_URL guard.
  it("loads successfully with DATABASE_URL unset (does not re-validate it, design D-5)", async () => {
    for (const key of REQUIRED_VARS) process.env[key] = "test-value";
    expect(process.env.DATABASE_URL).toBeUndefined();

    await expect(import("../src/env.js")).resolves.toBeDefined();
  });
});
