import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

// task 3.5, design D-5: `@dirus/db` throws at import time when
// `DATABASE_URL` is absent, so anything that transitively imports it cannot
// be loaded in a test without a live database. `createApp({ ingest, ... })`
// takes every `@dirus/db`-shaped dependency as an injected parameter
// specifically so this file — and every route mounted on the returned app,
// including `policy-bulk-import`'s admin route (Phase 6) — can be
// constructed and exercised with fakes, with zero `@dirus/db` import in
// this test's import graph.
//
// This file's own import graph is exactly: vitest, ../src/app.js (which
// imports "hono", ./routes/health.js, ./routes/webhooks/chatwoot.js, and
// ./routes/admin/policies-import.js — the last of which imports
// ./services/import-policies.js, itself `@dirus/db`-free, plus a TYPE-ONLY
// import of ./services/import-policies-writer.js, erased at compile time).
// None of these pull in @dirus/db, @dirus/schemas' runtime, or
// @dirus/integrations at RUNTIME — verified by reading each file directly
// and confirmed structurally by `pnpm run lint:deps`, which has no
// apps/api-specific exemption.
describe("createApp({ ingest, ... }) (design D-5: offline-testable factory)", () => {
  function fakeOptions(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
    return {
      ingest: vi.fn(async () => ({ deduplicated: false })),
      resolveBrokerId: vi.fn(async () => "broker-1"),
      webhookToken: "t".repeat(32),
      sendEcho: vi.fn(async () => undefined),
      adminToken: "a".repeat(32),
      resolveBrokerExists: vi.fn(async () => true),
      importPolicyRows: vi.fn(async (brokerId: string) => ({
        brokerId,
        totals: { rows: 0, inserted: 0, updated: 0, failed: 0 },
        rows: [],
      })),
      resolveBrokerIdByEmail: vi.fn(async () => null),
      issueMagicLinkToken: vi.fn(async () => undefined),
      sendMagicLink: vi.fn(async () => undefined),
      dashboardBaseUrl: "https://app.dirus.io",
      resolveBrokerIdByMagicLinkTokenHash: vi.fn(async () => null),
      consumeMagicLinkToken: vi.fn(async () => ({ ok: false as const })),
      createSession: vi.fn(async () => ({ rawSessionToken: "s".repeat(43), rawCsrfToken: "c".repeat(43) })),
      resolveSession: vi.fn(async () => null),
      revokeSession: vi.fn(async () => undefined),
      needsReviewQueue: vi.fn(async () => []),
      correctExtraction: vi.fn(async () => ({ found: true })),
      ...overrides,
    };
  }

  it("constructs an app from fakes and routes a request through it, with no database", async () => {
    const app = createApp(fakeOptions());
    const res = await app.request("/health");

    expect(res.status).toBe(200);
  });

  it("never invokes ingest just from being constructed", () => {
    const options = fakeOptions();

    createApp(options);

    expect(options.ingest).not.toHaveBeenCalled();
  });
});
