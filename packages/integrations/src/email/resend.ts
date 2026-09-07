/**
 * `admin-dashboard` (C1) task 3.1, O3 (email provider — "provider TBD at
 * apply time, no architectural stakes", proposal Product Decisions Round
 * 2): Resend, picked for a transactional-email-first API, no legacy
 * SMTP-relay setup burden, and a free tier generous enough for pilot
 * volume. Every consumer (Phase 3's magic-link route) depends on the
 * `SendMagicLinkFn` interface, not this concrete client, so this pick is a
 * small, contained substitution — never a blocker to sequencing.
 *
 * Mirrors `../chatwoot.ts`'s pattern in spirit: a minimal typed client over
 * a plain `fetch()` call, not a vendor SDK. `packages/integrations` has
 * zero runtime dependencies today (see `package.json`); Resend's own SDK
 * is itself a thin wrapper over this same HTTP API, so depending on it
 * would only reintroduce the dependency this package's zero-dep convention
 * avoids.
 */

const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";

export type SendMagicLinkFn = (to: string, url: string) => Promise<void>;

export type ResendEmailClientConfig = {
  apiKey: string;
  fromAddress: string;
};

export type ResendEmailClient = {
  sendMagicLink: SendMagicLinkFn;
};

/**
 * Creates a client bound to one Resend API key/from-address pair. Only
 * `apps/api/src/index.ts` constructs a real one; the magic-link route
 * accepts an injected `SendMagicLinkFn` instead of this client directly,
 * keeping `apps/api/src/app.ts` offline-testable (design.md D-D) — see
 * `chatwoot.ts`'s identical `createChatwootClient`/injected-`sendEcho`
 * convention.
 */
export function createResendEmailClient(config: ResendEmailClientConfig): ResendEmailClient {
  return {
    async sendMagicLink(to: string, url: string): Promise<void> {
      const res = await fetch(RESEND_EMAILS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          from: config.fromAddress,
          to: [to],
          subject: "Your DIRUS sign-in link",
          html: `<p>Click the link below to sign in to DIRUS. This link expires in 15 minutes.</p><p><a href="${url}">${url}</a></p>`,
        }),
      });

      if (!res.ok) {
        throw new Error(`Resend send failed: ${res.status} ${res.statusText} (to ${to})`);
      }
    },
  };
}
