/**
 * `admin-dashboard` (C1) task 7.3, design.md D-G: the **ONLY** place
 * `fetch()` is called anywhere in `apps/dashboard`. Every route/component
 * calls one of the functions below instead of `fetch()` directly — that
 * discipline is what lets `credentials: "include"`, the `X-Dirus-CSRF`
 * header, and the 401 → redirect-to-`/login` handler apply uniformly
 * everywhere, instead of needing to be remembered per call site.
 *
 * All requests are relative `/api/...` paths (never an absolute origin) —
 * D-G's whole point is that dev (Vite `server.proxy`) and prod (Caddy
 * `handle_path /api/*`) both make the SPA and the API same-origin, so no
 * base URL is ever configurable or needed here.
 */

/** `dirus_csrf` cookie name (design.md D-B) — NOT `HttpOnly`, so the SPA can read it. */
const CSRF_COOKIE_NAME = "dirus_csrf";
const CSRF_HEADER_NAME = "X-Dirus-CSRF";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Thrown by `apiRequest` on a `401` response, after the redirect to
 * `/login` has already been triggered — callers that catch this should
 * treat it as "navigation is already underway", never retry or surface it
 * as a generic error.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized (401) — redirecting to /login");
    this.name = "UnauthorizedError";
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`));

  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export type ApiRequestOptions = {
  method?: string;
  body?: unknown;
};

/**
 * The one `fetch()` call site (task 7.3). `credentials: "include"` sends
 * `dirus_session`/`dirus_csrf` on every request (design.md D-G, D-B); the
 * `X-Dirus-CSRF` header is attached only for mutating methods (csrf-guard.ts
 * exempts `GET`/`HEAD` itself, so sending it on safe methods would be inert
 * but is skipped anyway to keep this mirror exact). A `401` redirects to
 * `/login` and throws `UnauthorizedError` so callers stop processing
 * immediately instead of rendering a response body that never arrived.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie(CSRF_COOKIE_NAME);
    if (csrf) {
      headers[CSRF_HEADER_NAME] = csrf;
    }
  }

  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401) {
    window.location.assign("/login");
    throw new UnauthorizedError();
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : undefined;

  if (!response.ok) {
    throw new Error(
      `Request to ${path} failed with status ${response.status}${
        data && typeof data === "object" && "error" in data ? `: ${String((data as { error: unknown }).error)}` : ""
      }`,
    );
  }

  return data as T;
}
