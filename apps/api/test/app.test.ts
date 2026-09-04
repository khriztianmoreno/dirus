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
  it("constructs an app from a fake ingest and routes a request through it, with no database", async () => {
    const fakeIngest = vi.fn(async () => ({ deduplicated: false }));

    const app = createApp({ ingest: fakeIngest });
    const res = await app.request("/health");

    expect(res.status).toBe(200);
  });

  it("never invokes ingest just from being constructed", () => {
    const fakeIngest = vi.fn();

    createApp({ ingest: fakeIngest });

    expect(fakeIngest).not.toHaveBeenCalled();
  });
});
