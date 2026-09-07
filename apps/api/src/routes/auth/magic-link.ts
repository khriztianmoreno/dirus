import { createHash, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { magicLinkRequestSchema } from "@dirus/schemas";
import type { AppVariables } from "../../app.js";

/**
 * `POST /auth/magic-link` (`admin-dashboard` (C1) tasks 3.6-3.11, design.md
 * D-C's exact ordering, broker-auth spec "Magic-Link Request Endpoint",
 * "Anti-Enumeration Response Is Indistinguishable").
 *
 * Injected exactly like `tenant-resolver.ts`'s `ResolveBrokerId` and
 * `import-policies.ts`'s `ImportPolicyRowsFn`: never a real `@dirus/db` or
 * `@dirus/integrations` import here, so this route stays offline-testable
 * (design.md D-D). Only `apps/api/src/index.ts` wires in the real
 * `resolveBrokerIdByEmail` (`@dirus/db`), the real issue-token service
 * (`services/auth/issue-magic-link.ts`, which owns the actual
 * `withBrokerContext` transaction), and the real `sendMagicLink`
 * (`@dirus/integrations`).
 */
export type ResolveBrokerIdByEmail = (email: string) => Promise<string | null>;

/**
 * Represents the WHOLE "insert magic_link_tokens (COMMIT)" step from
 * design.md's data-flow diagram, opaque to this route — the route never
 * knows or cares that the real implementation opens its own
 * `withBrokerContext` transaction and additionally resolves
 * `broker_user_id` internally (design.md D-A: the resolver functions
 * return only a bare `broker_id`, never a row, so the real writer must do
 * that second lookup itself, inside the same broker-scoped transaction,
 * never in this route).
 */
export type IssueMagicLinkTokenFn = (params: {
  brokerId: string;
  /**
   * The same email that resolved to `brokerId` above. The real
   * implementation needs it because `resolveBrokerIdByEmail` (design.md
   * D-A) returns only a bare `broker_id`, never a row — so the real writer
   * must independently look up the `broker_user_id` the
   * `magic_link_tokens.broker_user_id` NOT NULL column requires, scoped
   * inside the SAME `withBrokerContext` transaction (RLS-safe: the lookup
   * runs under `app.broker_id = brokerId`, and `email` is globally
   * unique).
   */
  email: string;
  tokenHash: string;
  expiresAt: Date;
}) => Promise<void>;

export type SendMagicLinkFn = (to: string, url: string) => Promise<void>;

export type MagicLinkRouteOptions = {
  resolveBrokerIdByEmail: ResolveBrokerIdByEmail;
  issueMagicLinkToken: IssueMagicLinkTokenFn;
  sendMagicLink: SendMagicLinkFn;
  /** `env.DASHBOARD_BASE_URL` — no trailing slash (design.md D-G). */
  dashboardBaseUrl: string;
};

const MAGIC_LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * The ONE response body/status this route ever returns for a
 * request-shape it processed — a fixed literal (design.md D-C: "a fixed
 * literal, byte-identical, no id, no echo of the input, no retryAfter").
 * Returned for a known email, an unknown-but-well-formed email, a
 * well-formed email resolving to `null`, AND a malformed/non-email-shaped
 * body — see the reconciliation note below for why the last case is 202
 * here rather than design.md's stated 400 carve-out.
 */
const ACCEPTED_BODY = { status: "accepted" } as const;
const ACCEPTED_STATUS = 202;

export function registerMagicLinkRoute(
  app: Hono<{ Variables: AppVariables }>,
  { resolveBrokerIdByEmail, issueMagicLinkToken, sendMagicLink, dashboardBaseUrl }: MagicLinkRouteOptions,
): void {
  app.post("/auth/magic-link", async (c) => {
    const json = await c.req.json().catch(() => undefined);
    const parsed = magicLinkRequestSchema.safeParse(json);

    if (!parsed.success) {
      // RECONCILIATION NOTE (task 3.10, deviation from design.md D-C's
      // literal text): D-C says "400 is returned only when the Zod body
      // schema fails". broker-auth spec's own scenario "A malformed email
      // still returns the generic response shape" is stricter and
      // unambiguous: a malformed value ("not-an-email") MUST get the exact
      // same status/body as a well-formed-unknown email. Since Zod failure
      // is the ONLY way this route currently distinguishes "malformed" from
      // "well-formed", honoring the spec's scenario literally means never
      // returning a distinct 400 shape here — doing so would itself be the
      // narrowing the spec scenario explicitly forbids. Resolved in favor
      // of the spec (the stated acceptance criterion) over the design's
      // looser carve-out; flagged in apply-progress.md as a design/spec
      // tension, not silently reconciled.
      return c.json(ACCEPTED_BODY, ACCEPTED_STATUS);
    }

    const brokerId = await resolveBrokerIdByEmail(parsed.data.email);

    if (brokerId !== null) {
      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = new Date(Date.now() + MAGIC_LINK_TOKEN_TTL_MS);

      // COMMIT happens inside this call (design.md D-C's data-flow
      // diagram). Only once this resolves does the email get dispatched —
      // task 3.6's ordering assertion, and the thing that avoids
      // `withBrokerContext`'s reentrancy trap (tenant.ts: the guard tracks
      // async-resource lineage, not the commit boundary, so spawning the
      // detached send from INSIDE this call's callback would be wrongly
      // rejected as reentrant).
      await issueMagicLinkToken({ brokerId, email: parsed.data.email, tokenHash, expiresAt });

      const url = `${dashboardBaseUrl}/auth/callback?token=${rawToken}`;
      // Detached: dispatched AFTER the await above resolves, never awaited
      // itself (design.md D-C — the Node adapter has no
      // `c.executionCtx.waitUntil`). `.catch(log)` is mandatory: an
      // unhandled rejection here would crash the process.
      void sendMagicLink(parsed.data.email, url).catch((error) => {
        console.error("magic_link_send_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return c.json(ACCEPTED_BODY, ACCEPTED_STATUS);
  });
}
