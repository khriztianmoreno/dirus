import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `admin-dashboard` (C1) task 7.2, design.md D-G: `server.proxy` makes the
 * Vite dev origin behave same-origin exactly like prod will via Caddy's
 * `handle_path /api/*` (D-G). This is why `src/api/client.ts` can always
 * call relative `/api/...` paths and never needs a configurable base URL,
 * in dev or prod. Chosen over CORS-in-dev specifically so the
 * `dirus_session`/`dirus_csrf` cookies behave identically in both
 * environments (design.md D-G).
 *
 * `rewrite` strips the `/api` prefix before forwarding, mirroring Caddy's
 * `handle_path /api/*` in prod (`handle_path`, unlike `handle`, strips the
 * matched prefix by definition — see `infra/Caddyfile`). `apps/api`'s own
 * routes are registered with NO `/api` prefix (`app.ts`: `/auth/me`,
 * `/dashboard/review-queue`, ...), so this proxy has to strip it too, or
 * dev and prod would resolve different backend paths for the identical
 * `client.ts` request.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
