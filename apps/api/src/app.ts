import { Hono } from "hono";

import { registerHealthRoute } from "./routes/health.js";

/**
 * The ingest pipeline's real signature belongs to Phase 5
 * (`services/ingest-message.ts`, design D-2/D-3/D-5, "no HTTP types cross
 * this line"). It is loosely typed here on purpose — Phase 3 wires no route
 * to it yet, only `createApp`'s shape is established.
 */
export type Ingest = (brokerId: string, payload: unknown) => Promise<unknown>;

export type AppVariables = {
  ingest: Ingest;
};

export type CreateAppOptions = {
  ingest: Ingest;
};

/**
 * `createApp({ ingest })` — a factory, not a module-level singleton (design
 * D-5). `@dirus/db` throws at import time when `DATABASE_URL` is absent, so
 * anything that transitively imports it cannot be loaded in a test without a
 * live database. Taking `ingest` as an injected parameter is what lets this
 * module — and every route mounted on it — stay importable and exercisable
 * in tests with a fake, with zero `@dirus/db` import reachable from the
 * test's import graph. Only `index.ts` wires in the real implementation
 * (Phase 5).
 *
 * `ingest` is threaded into `c.var.ingest` (mirroring the
 * `middleware/tenant-resolver.ts` -> `c.var.brokerId` convention Phase 5
 * establishes) so the webhook route, once it exists, does not require
 * reshaping this factory's signature. No route in Phase 3 reads it — only
 * the health route is mounted here.
 */
export function createApp({ ingest }: CreateAppOptions): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (c, next) => {
    c.set("ingest", ingest);
    await next();
  });

  registerHealthRoute(app);

  return app;
}
