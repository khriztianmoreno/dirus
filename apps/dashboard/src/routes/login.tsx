import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { apiRequest } from "../api/client.js";

/**
 * `admin-dashboard` (C1) task 7.5, design.md D-C, broker-auth spec
 * "Anti-Enumeration Response Is Indistinguishable". `POST /api/auth/magic-link`
 * always returns the identical `{"status":"accepted"}` body/202 regardless
 * of whether the email is known, unknown, or well-formed-but-resolves-to
 * `null` — this form's job is to preserve that indistinguishability all the
 * way to the rendered UI, not just pass it through.
 *
 * **The one state that matters here**: once the request has been sent, the
 * form shows the SAME fixed acknowledgement copy no matter what happened —
 * a known email, an unknown email, or even a network/5xx failure. A
 * distinguishable "something went wrong, try again" state on a network
 * error vs. a plain "check your email" state on success would itself be a
 * NEW enumeration oracle layered on top of the API's already-flattened
 * one (an attacker could correlate "the request definitely reached the
 * server and got a real 202" against "it silently failed" by other means —
 * e.g. timing, or by knowing their own network is fine — so the two cases
 * must render identically here). This is why the `catch` block below
 * renders the exact same `submitted` state as the `then` branch, instead
 * of a distinct error UI.
 *
 * **`?error=invalid_token`**: `callback.ts`'s `rejectRedirect` sends the
 * browser here — `/login`, not `/auth/callback` (see
 * `auth-callback.tsx`'s reconciliation note) — on a replayed, expired, or
 * unknown magic-link token. This is unrelated to the anti-enumeration
 * concern above (it fires only AFTER a token was already clicked), so it
 * is rendered as its own, clearly distinct banner, not folded into the
 * fixed acknowledgement copy.
 */
const ACKNOWLEDGEMENT_TEXT = "If that email is registered, a sign-in link has been sent to it.";

type FormState = "idle" | "submitting" | "submitted";

export function LoginRoute() {
  const [searchParams] = useSearchParams();
  const callbackError = searchParams.get("error");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FormState>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("submitting");

    try {
      await apiRequest("/auth/magic-link", { method: "POST", body: { email } });
    } catch {
      // Deliberately swallowed — see module docstring. Whatever happened
      // (a real 202, a network error, an unexpected 5xx), the rendered
      // outcome must be identical.
    }

    setState("submitted");
  }

  if (state === "submitted") {
    return (
      <main>
        <h1>Sign in</h1>
        <p>{ACKNOWLEDGEMENT_TEXT}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Sign in</h1>
      {callbackError ? <p role="alert">This sign-in link is invalid or has expired. Request a new one.</p> : null}
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={state === "submitting"}
        />
        <button type="submit" disabled={state === "submitting"}>
          Send sign-in link
        </button>
      </form>
    </main>
  );
}
