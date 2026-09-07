import { useEffect } from "react";
import { useSearchParams } from "react-router";

/**
 * `admin-dashboard` (C1) task 7.6, design.md D-G/D-C data-flow.
 *
 * **RECONCILIATION NOTE** (mirroring `magic-link.ts`'s own convention of
 * flagging design/task tension explicitly rather than silently resolving
 * it): task 7.6 describes this route as handling "the redirect landing
 * from `GET /api/auth/callback`" and showing an error state "when
 * redirected with `?error`". Read literally against `callback.ts`'s
 * actual code, the backend's OWN error-redirect target is
 * `${DASHBOARD_BASE_URL}/login?error=invalid_token` — never
 * `/auth/callback?error=...` — and its success target is
 * `${DASHBOARD_BASE_URL}/`. What DOES land on `/auth/callback` is the
 * magic-link EMAIL itself: `magic-link.ts` builds
 * `${dashboardBaseUrl}/auth/callback?token=${rawToken}` — this SPA
 * route's actual job is to be the landing page for the CLICKED EMAIL
 * LINK (a `?token=...` param), not a page the backend redirects to.
 *
 * This component does two things to satisfy both the task's literal ask
 * and the real backend contract:
 *
 *   1. On mount with a `?token=…` param, performs a REAL full-page
 *      navigation (`window.location.assign`, deliberately NOT
 *      `client.ts`'s `apiRequest`/`fetch`) to `/api/auth/callback?token=…`.
 *      That endpoint's whole contract is `Set-Cookie` + `302`, designed
 *      for the browser to follow natively — a `fetch` call would apply
 *      the `Set-Cookie` too, but would leave this SPA responsible for
 *      re-deriving the final destination instead of just letting the
 *      browser land there directly.
 *   2. Defensively also reads `?error` from ITS OWN query string (in case
 *      a future/alternate deployment ever redirects failures back to this
 *      path instead of `/login`) and renders the same error copy
 *      `login.tsx` renders for `/login?error=…` — the backend's actual,
 *      current failure target.
 */
export function AuthCallbackRoute() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const error = searchParams.get("error");

  useEffect(() => {
    if (token && !error) {
      window.location.assign(`/api/auth/callback?token=${encodeURIComponent(token)}`);
    }
  }, [token, error]);

  if (error) {
    return (
      <main>
        <h1>Sign-in failed</h1>
        <p>This sign-in link is invalid or has expired. Request a new one.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Signing you in…</h1>
    </main>
  );
}
