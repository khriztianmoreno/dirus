import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  buildCsrfCookieHeader,
  buildSessionCookieHeader,
} from "../../../src/services/auth/session-cookies.js";

/**
 * `admin-dashboard` (C1) task 3.18, design.md D-B's exact cookie
 * attributes:
 *
 *   Set-Cookie: dirus_session=<32B base64url>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800
 *   Set-Cookie: dirus_csrf=<32B base64url>;                Secure; SameSite=Lax; Path=/; Max-Age=604800
 *
 * Both `Max-Age=604800` (7 days), no `Domain` attribute (host-only, design.md
 * D-G). `dirus_csrf` carries every `dirus_session` attribute MINUS
 * `HttpOnly` — the SPA must be able to read it to echo it in the
 * `X-Dirus-CSRF` header.
 */
describe("session cookie builders (design.md D-B, task 3.18)", () => {
  it("SESSION_COOKIE_MAX_AGE_SECONDS is exactly 7 days in seconds", () => {
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(604800);
  });

  it("buildSessionCookieHeader: HttpOnly, Secure, SameSite=Lax, Max-Age=604800, no Domain", () => {
    const header = buildSessionCookieHeader("raw-session-token");

    expect(header).toBe("dirus_session=raw-session-token; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
  });

  it("buildCsrfCookieHeader: identical attributes minus HttpOnly", () => {
    const header = buildCsrfCookieHeader("raw-csrf-token");

    expect(header).toBe("dirus_csrf=raw-csrf-token; Secure; SameSite=Lax; Path=/; Max-Age=604800");
    expect(header).not.toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
  });
});
