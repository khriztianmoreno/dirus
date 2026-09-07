import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";

// task 3.7: GET /health returns 200 with no auth required and no database
// access. `createApp` is given a fake `ingest` (design D-5) so this test
// runs fully offline — no @dirus/db import is reachable from this file's
// import graph.
describe("GET /health (no auth, no database access)", () => {
  it("returns 200 with a body, with no Authorization header set", async () => {
    const fakeIngest = vi.fn();
    const app = createApp({
      ingest: fakeIngest,
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
      metrics: {
        copilotShare: vi.fn(async () => ({ value: { count: 0 }, sampleSize: 0, empty: true })),
        renewalStatus: vi.fn(async () => ({ value: {}, sampleSize: 0, empty: true })),
        needsReviewRate: vi.fn(async () => ({ value: { flagged: 0, total: 0, rate: 0 }, sampleSize: 0, empty: true })),
        conversationStatusSnapshot: vi.fn(async () => ({
          value: {},
          sampleSize: 0,
          empty: true,
          snapshotType: "current-state" as const,
        })),
        timeToFirstRenewal: vi.fn(async () => ({ value: null, sampleSize: 0, empty: true })),
        cost: vi.fn(async () => ({ value: null, sampleSize: 0, empty: true, status: "deferred" as const })),
      },
    });

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
    // No route in Phase 3 calls ingest at all — the health route in
    // particular must never touch it.
    expect(fakeIngest).not.toHaveBeenCalled();
  });
});
