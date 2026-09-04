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
