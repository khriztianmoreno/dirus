import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

// task 3.5, design D-5: `@dirus/db` throws at import time when
// `DATABASE_URL` is absent, so anything that transitively imports it cannot
// be loaded in a test without a live database. `createApp({ ingest })` takes
// the ingest function as a parameter specifically so this file — and every
// route mounted on the returned app — can be constructed and exercised with
// a fake, with zero `@dirus/db` import in this test's import graph.
//
// This file's own import graph is exactly: vitest, ../src/app.js (which
// imports only "hono" and ./routes/health.js). Neither imports @dirus/db,
// @dirus/schemas, or @dirus/integrations — verified by reading src/app.ts
// and src/routes/health.ts directly (no import of any workspace package
// other than "hono" appears in either file) and confirmed structurally by
// `pnpm run lint:deps`, which has no apps/api-specific exemption.
describe("createApp({ ingest }) (design D-5: offline-testable factory)", () => {
  function fakeOptions(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
    return {
      ingest: vi.fn(async () => ({ deduplicated: false })),
      resolveBrokerId: vi.fn(async () => "broker-1"),
      webhookToken: "t".repeat(32),
      sendEcho: vi.fn(async () => undefined),
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
