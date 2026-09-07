import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { RequireSession } from "./components/RequireSession.js";
import { LoginRoute } from "./routes/login.js";
import { AuthCallbackRoute } from "./routes/auth-callback.js";
import { ReviewQueueRoute } from "./routes/review-queue.js";
import { MetricsRoute } from "./routes/metrics.js";

/**
 * `admin-dashboard` (C1) task 7.1, design.md D-G: `react-router`
 * declarative mode (`<BrowserRouter>`/`<Routes>`/`<Route>`) — no framework
 * mode, no SSR (design.md D-G, docs/ARCHITECTURE.md's "build estático").
 * `/login` and `/auth/callback` are public; every other route is wrapped
 * in `RequireSession` (task 7.4).
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/auth/callback" element={<AuthCallbackRoute />} />
        <Route
          path="/"
          element={
            <RequireSession>
              <Navigate to="/review-queue" replace />
            </RequireSession>
          }
        />
        <Route
          path="/review-queue"
          element={
            <RequireSession>
              <ReviewQueueRoute />
            </RequireSession>
          }
        />
        <Route
          path="/metrics"
          element={
            <RequireSession>
              <MetricsRoute />
            </RequireSession>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
