import { useEffect, useState, type ReactNode } from "react";
import { apiRequest, UnauthorizedError } from "../api/client.js";
import type { MeResponse } from "../api/types.js";

/**
 * `admin-dashboard` (C1) task 7.4, design.md D-G. Calls `GET /api/auth/me`
 * once on mount, via `client.ts` — never `fetch()` directly (task 7.3's
 * discipline). A `401` is already handled by `apiRequest` itself (redirect
 * to `/login`); this component only needs to stop rendering `children`
 * while that redirect is underway.
 */
type RequireSessionProps = {
  children: ReactNode;
};

type SessionState =
  | { status: "loading" }
  | { status: "authenticated"; me: MeResponse }
  | { status: "redirecting" };

export function RequireSession({ children }: RequireSessionProps): ReactNode {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    apiRequest<MeResponse>("/auth/me")
      .then((me) => {
        if (!cancelled) {
          setState({ status: "authenticated", me });
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (error instanceof UnauthorizedError) {
          // apiRequest already triggered window.location.assign("/login").
          setState({ status: "redirecting" });
          return;
        }
        // A non-401 failure (network error, 5xx) — still redirect to
        // /login rather than rendering protected children with no
        // resolved session, but this is a distinct, logged case.
        console.error("session_check_failed", error);
        setState({ status: "redirecting" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status !== "authenticated") {
    return null;
  }

  return children;
}
