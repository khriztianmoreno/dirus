import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSession, SessionAuthVariables } from "../../../src/middleware/session-auth.js";
import { registerMetricsRoute, type MetricsRouteOptions } from "../../../src/routes/dashboard/metrics.js";

/**
 * `admin-dashboard` (C1) task 6.15 (RED), design.md D-F, product-metrics
 * spec "Metrics Are Scoped to the Authenticated Broker" (offline half; the
 * live cross-tenant half is Phase 8). Entirely offline, mirrors
 * `review-queue.test.ts`'s injected-fake convention: every metric function
 * here is a fake — the real `@dirus/db`-backed implementations have their
 * own live proof (`metrics.live.test.ts`, tasks 6.3/6.6) and their own
 * offline unit proofs (`test/services/metrics/*.test.ts`).
 */
type Variables = SessionAuthVariables;

const SESSION_A: ResolvedSession = {
  brokerId: "11111111-1111-1111-1111-111111111111",
  brokerUserId: "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
  role: "broker_admin",
  csrfTokenHash: "irrelevant-in-this-suite",
};

function fakeOptions(overrides: Partial<MetricsRouteOptions> = {}): MetricsRouteOptions {
  return {
    copilotShare: vi.fn(async () => ({ value: { count: 0 }, sampleSize: 0, empty: true })),
    renewalStatus: vi.fn(async () => ({ value: {}, sampleSize: 0, empty: true })),
    needsReviewRate: vi.fn(async () => ({
      value: { flagged: 0, total: 0, rate: 0 },
      sampleSize: 0,
      empty: true,
    })),
    conversationStatusSnapshot: vi.fn(async () => ({
      value: {},
      sampleSize: 0,
      empty: true,
      snapshotType: "current-state" as const,
    })),
    timeToFirstRenewal: vi.fn(async () => ({ value: null, sampleSize: 0, empty: true })),
    cost: vi.fn(async () => ({ value: null, sampleSize: 0, empty: true, status: "deferred" as const })),
    ...overrides,
  };
}

function buildApp(opts: Partial<MetricsRouteOptions> = {}, session: ResolvedSession = SESSION_A) {
  const options = fakeOptions(opts);
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("brokerId", session.brokerId);
    c.set("session", session);
    await next();
  });
  registerMetricsRoute(app, options);
  return { app, options };
}

const ROUTES: Array<[string, keyof MetricsRouteOptions]> = [
  ["/dashboard/metrics/copilot-share", "copilotShare"],
  ["/dashboard/metrics/renewal-status", "renewalStatus"],
  ["/dashboard/metrics/needs-review-rate", "needsReviewRate"],
  ["/dashboard/metrics/conversation-status-snapshot", "conversationStatusSnapshot"],
  ["/dashboard/metrics/time-to-first-renewal", "timeToFirstRenewal"],
  ["/dashboard/metrics/cost", "cost"],
];

describe("dashboard metrics routes (tasks 6.15-6.16)", () => {
  for (const [path, key] of ROUTES) {
    it(`${path}: each of the six metric routes returns a 2xx result shaped for its own metric`, async () => {
      const { app } = buildApp();

      const res = await app.request(path);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { empty: boolean };
      expect(body).toHaveProperty("empty");
    });

    it(`${path}: resolves broker_id from c.var.brokerId exclusively — a client-supplied brokerId query param has zero effect`, async () => {
      const fn = vi.fn(async () => ({ value: null, sampleSize: 0, empty: true, status: "deferred" as const }));
      const { app } = buildApp({ [key]: fn } as Partial<MetricsRouteOptions>);

      await app.request(`${path}?brokerId=attacker-broker-id`);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(SESSION_A.brokerId);
      expect(fn).not.toHaveBeenCalledWith("attacker-broker-id");
    });
  }
});

describe("offline-testability", () => {
  it("this route module's import graph never reaches @dirus/db (mirrors review-queue.test.ts's structural claim)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../../../src/routes/dashboard/metrics.ts", import.meta.url)),
      "utf-8",
    );

    expect(source).not.toMatch(/from\s+["']@dirus\/db["']/);
  });
});
