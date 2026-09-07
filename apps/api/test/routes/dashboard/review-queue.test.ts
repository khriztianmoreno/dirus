import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSession, SessionAuthVariables } from "../../../src/middleware/session-auth.js";
import {
  registerReviewQueueRoute,
  type CorrectExtractionFn,
  type NeedsReviewQueueFn,
  type ReviewQueueRow,
} from "../../../src/routes/dashboard/review-queue.js";

/**
 * `admin-dashboard` (C1) tasks 5.6-5.7 (RED, list endpoint), 5.9-5.11 (RED,
 * correction endpoint), extraction-review spec (all requirements). Entirely
 * offline, mirroring `policies-import.test.ts`'s injected-fake convention:
 * `needsReviewQueue`/`correctExtraction` are both fakes here — the real
 * `@dirus/db`-backed implementations have their own live proof (task 5.13).
 *
 * `session-auth.ts`/`csrf-guard.ts` are NOT re-tested here (Phase 4 already
 * owns that middleware's own test suite) — this suite injects
 * `c.var.brokerId`/`c.var.session` directly via a minimal pass-through
 * middleware, mirroring `session-lifecycle.live.test.ts`'s "probe app"
 * convention, so the route's OWN behavior (never the middleware's) is what
 * these assertions exercise.
 */
type Variables = SessionAuthVariables;

const SESSION_A: ResolvedSession = {
  brokerId: "11111111-1111-1111-1111-111111111111",
  brokerUserId: "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
  role: "broker_admin",
  csrfTokenHash: "irrelevant-in-this-suite",
};

function buildApp(opts: {
  session?: ResolvedSession;
  needsReviewQueue?: NeedsReviewQueueFn;
  correctExtraction?: CorrectExtractionFn;
} = {}) {
  const session = opts.session ?? SESSION_A;
  const needsReviewQueue = opts.needsReviewQueue ?? (vi.fn(async () => []) as unknown as NeedsReviewQueueFn);
  const correctExtraction =
    opts.correctExtraction ??
    (vi.fn(async () => ({ found: true })) as unknown as CorrectExtractionFn);

  const app = new Hono<{ Variables: Variables }>();
  // Stand-in for Phase 4's session-auth middleware: sets exactly the two
  // context variables the real middleware sets, from a fixed test session —
  // never from any client-supplied value, matching `session-auth.ts`'s own
  // contract.
  app.use("*", async (c, next) => {
    c.set("brokerId", session.brokerId);
    c.set("session", session);
    await next();
  });
  registerReviewQueueRoute(app, { needsReviewQueue, correctExtraction });

  return { app, needsReviewQueue, correctExtraction };
}

function fakeRow(overrides: Partial<ReviewQueueRow>): ReviewQueueRow {
  return {
    id: "extraction-id",
    brokerId: SESSION_A.brokerId,
    output: { policyNumber: "POL-1" },
    confidence: { policyNumber: 0.9 },
    needsReview: true,
    ...overrides,
  };
}

describe("GET /dashboard/review-queue (tasks 5.6-5.8)", () => {
  it("5.6: given three rows for broker B (two needs_review=true, one false), the response contains exactly the two flagged rows", async () => {
    const rows: ReviewQueueRow[] = [
      fakeRow({ id: "row-1", needsReview: true }),
      fakeRow({ id: "row-2", needsReview: false }),
      fakeRow({ id: "row-3", needsReview: true }),
    ];
    const { app } = buildApp({ needsReviewQueue: vi.fn(async () => rows) as unknown as NeedsReviewQueueFn });

    const res = await app.request("/dashboard/review-queue");
    const body = (await res.json()) as { rows: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(body.rows.map((r) => r.id).sort()).toEqual(["row-1", "row-3"]);
  });

  it("5.7: the query function is called with c.var.brokerId (session-resolved), never a client-supplied value", async () => {
    const needsReviewQueue = vi.fn(async () => []) as unknown as NeedsReviewQueueFn;
    const { app } = buildApp({ needsReviewQueue });

    // A client-supplied brokerId in the query string must have zero effect
    // — the route must never read it.
    await app.request("/dashboard/review-queue?brokerId=attacker-broker-id");

    expect(needsReviewQueue).toHaveBeenCalledTimes(1);
    expect(needsReviewQueue).toHaveBeenCalledWith(SESSION_A.brokerId);
    expect(needsReviewQueue).not.toHaveBeenCalledWith("attacker-broker-id");
  });

  it("5.7: a fake returning broker-A-only rows for a broker-A session never includes broker-B rows", async () => {
    const brokerBRow = fakeRow({ id: "broker-b-row", brokerId: "22222222-2222-2222-2222-222222222222" });
    const brokerARow = fakeRow({ id: "broker-a-row", brokerId: SESSION_A.brokerId });
    // The fake itself only ever returns broker-A's own rows for a broker-A
    // brokerId argument — proving the route renders exactly what its single
    // trusted input (c.var.brokerId) resolves to, with no other broker's
    // row reachable through this session.
    const needsReviewQueue = vi.fn(async (brokerId: string) =>
      brokerId === SESSION_A.brokerId ? [brokerARow] : [brokerBRow],
    ) as unknown as NeedsReviewQueueFn;
    const { app } = buildApp({ needsReviewQueue });

    const res = await app.request("/dashboard/review-queue");
    const body = (await res.json()) as { rows: Array<{ id: string }> };

    expect(body.rows.map((r) => r.id)).toEqual(["broker-a-row"]);
    expect(body.rows.map((r) => r.id)).not.toContain("broker-b-row");
  });

  it("5.8 (fallback rendering): a row whose output/confidence do not conform degrades to a raw-JSON marker, response still 200", async () => {
    const malformedRow = fakeRow({
      id: "malformed-row",
      output: { policyNumber: "POL-1" },
      confidence: { totallyUnrelatedKey: 0.9 },
    });
    const { app } = buildApp({ needsReviewQueue: vi.fn(async () => [malformedRow]) as unknown as NeedsReviewQueueFn });

    const res = await app.request("/dashboard/review-queue");
    const body = (await res.json()) as { rows: Array<{ id: string; envelope: { ok: boolean } }> };

    expect(res.status).toBe(200);
    expect(body.rows[0].envelope.ok).toBe(false);
  });
});

describe("POST /dashboard/review-queue/:id/correction (tasks 5.9-5.12)", () => {
  it("5.9: a body naming a different correctedBy is ignored — the session's own broker_user_id is what reaches the write function", async () => {
    const correctExtraction = vi.fn(async () => ({ found: true })) as unknown as CorrectExtractionFn;
    const { app } = buildApp({ correctExtraction });

    const res = await app.request("/dashboard/review-queue/extraction-1/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        correctedOutput: { endDate: "2027-06-01" },
        correctedBy: "attacker-supplied-broker-user-id",
      }),
    });

    expect(res.status).toBe(200);
    expect(correctExtraction).toHaveBeenCalledTimes(1);
    const call = correctExtraction.mock.calls[0][0] as { correctedBy: string };
    expect(call.correctedBy).toBe(SESSION_A.brokerUserId);
    expect(call.correctedBy).not.toBe("attacker-supplied-broker-user-id");
  });

  it("5.10: a successful correction results in exactly one write call with correctedOutput and correctedBy", async () => {
    const correctExtraction = vi.fn(async () => ({ found: true })) as unknown as CorrectExtractionFn;
    const { app } = buildApp({ correctExtraction });

    const res = await app.request("/dashboard/review-queue/extraction-1/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correctedOutput: { endDate: "2027-06-01" } }),
    });

    expect(res.status).toBe(200);
    expect(correctExtraction).toHaveBeenCalledTimes(1);
    expect(correctExtraction).toHaveBeenCalledWith({
      brokerId: SESSION_A.brokerId,
      extractionId: "extraction-1",
      correctedOutput: { endDate: "2027-06-01" },
      correctedBy: SESSION_A.brokerUserId,
    });
  });

  it("5.11: a request failing Zod validation (missing correctedOutput) results in ZERO write-function calls", async () => {
    const correctExtraction = vi.fn(async () => ({ found: true })) as unknown as CorrectExtractionFn;
    const { app } = buildApp({ correctExtraction });

    const res = await app.request("/dashboard/review-queue/extraction-1/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(correctExtraction).not.toHaveBeenCalled();
  });

  it("5.11: a non-JSON body also results in ZERO write-function calls", async () => {
    const correctExtraction = vi.fn(async () => ({ found: true })) as unknown as CorrectExtractionFn;
    const { app } = buildApp({ correctExtraction });

    const res = await app.request("/dashboard/review-queue/extraction-1/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(correctExtraction).not.toHaveBeenCalled();
  });

  it("5.14: no code path writes a guessed value into correctedOutput beyond exactly what the request body supplied", async () => {
    const correctExtraction = vi.fn(async () => ({ found: true })) as unknown as CorrectExtractionFn;
    const { app } = buildApp({ correctExtraction });

    // Only ONE field submitted for a row whose output has two fields — the
    // route must never fill in the other field from `output`/`confidence`.
    await app.request("/dashboard/review-queue/extraction-1/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correctedOutput: { endDate: "2027-06-01" } }),
    });

    const call = correctExtraction.mock.calls[0][0] as { correctedOutput: Record<string, unknown> };
    expect(call.correctedOutput).toEqual({ endDate: "2027-06-01" });
    expect(Object.keys(call.correctedOutput)).toEqual(["endDate"]);
  });
});

describe("offline-testability", () => {
  it("this route module's import graph never reaches @dirus/db (mirrors policies-import.test.ts's structural claim)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../../../src/routes/dashboard/review-queue.ts", import.meta.url)),
      "utf-8",
    );

    expect(source).not.toMatch(/from\s+["']@dirus\/db["']/);

    // `needs-review-queue.js`/`correct-extraction.js` (both import
    // @dirus/db) are referenced ONLY as type-only imports/re-exports,
    // erased at compile time — `needsReviewQueue`/`correctExtraction` are
    // injected parameters, never imported as values.
    const serviceImportLines = source
      .split("\n")
      .filter((line) => line.includes("services/queries/") && /^\s*(import|export)\s/.test(line));
    expect(serviceImportLines.length).toBeGreaterThan(0);
    for (const line of serviceImportLines) {
      expect(line).toMatch(/^\s*(import|export)\s+type\s/);
    }
  });
});
