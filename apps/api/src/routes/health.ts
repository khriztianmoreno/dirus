import type { Hono } from "hono";

import type { AppVariables } from "../app.js";

/**
 * `GET /health` — liveness check. No auth, no database access (task 3.7).
 * Never touches `c.var.ingest`.
 */
export function registerHealthRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get("/health", (c) => c.json({ status: "ok" }));
}
