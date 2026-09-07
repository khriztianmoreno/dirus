# Proposal: Admin dashboard

## Intent

Every operational surface DIRUS has today is a machine-to-machine endpoint. There is no way for a human broker to log in, see anything, or correct anything. Three consequences are already visible in the repo:

1. **`extractions.needs_review` has no reader.** The column and its partial index exist. The re-ask flow that B2 will build assumes a human eventually resolves the flag. Nobody can.
2. **The 6 product metrics in `docs/ARCHITECTURE.md` §12 exist only as a table in a document.** No query, no endpoint, no view. "Todas visibles en el dashboard admin" — the dashboard does not exist.
3. **`apps/api/src/middleware/admin-auth.ts` is a shared bearer token whose own docstring says it is "superseded the moment `admin-dashboard` (C1) ships real broker/admin authentication".** This change is that moment. Until it lands, the only credential guarding a cross-tenant write endpoint (`POST /admin/policies/import`) is a replayable static secret.

There is also a hard prerequisite nobody has written down: **`broker_users` has no credential column of any kind.** The table is `id, brokerId, name, phone, role, createdAt`. No email, no password, no token. There is no login to build against — the identity substrate has to be created by this change.

**This change is `(ff)`-tagged in `ROADMAP.md`. That tag is wrong and this proposal rejects it**, on the same grounds `policy-bulk-import` (A1) used when its scope grew past its own `(ff)` tag. C1 introduces the first frontend application in the monorepo, the first real authentication mechanism, the first email-sending dependency, and a new table. That is architecture, not mechanical wiring. `sdd-design` must run — not be skipped.

**Why now, with both tracks blocked.** A2 (`renewal-agent`) is blocked on Meta HSM approval and B2 (`ingestion-agent`) on the golden dataset; neither has moved. C1 is the only convergence work whose dependencies are *data*, not *approval*. `extractions` and `renewals` already exist with zero rows. A metrics layer built now returns correct-and-empty results, and starts returning real numbers the day either track lands — with no further work.

## Scope

### In Scope

- **Email magic-link authentication** (P1): request-link endpoint, token-consumption endpoint, session establishment, logout.
- **Schema**: `broker_users.email` (new nullable column, P2) and a new `magic_link_tokens` table (P3). Both via migration.
- **A session mechanism** — httpOnly signed cookie (P4).
- **Server-side tenant resolution from the session.** The client never supplies `brokerId` on any dashboard request, extending `tenant-resolver.ts`'s established rule from `wa_phone_number_id` to an authenticated human identity.
- **`apps/dashboard` as a real Vite + React SPA**, built to a static bundle at `apps/dashboard/dist` per `docs/ARCHITECTURE.md`. No SSR. Standalone build config (P7).
- **Extraction review queue**: list `extractions WHERE needs_review`, view the document's extracted output, correct field values, clear the flag.
- **Metrics endpoints + panels for all 6 §12 metrics**, built now against existing columns (P6).
- **A transactional email integration** in `packages/integrations` (P5).
- **Removal of `admin-auth.ts`'s shared token from any route a logged-in human can now reach** — or an explicit, written decision to keep it for machine callers only.

### Out of Scope

- **Broker self-signup / user management UI.** `broker_users` rows are created by an operator (direct insert / seed) for the pilot. A create-user screen is later work.
- **Roles and permissions beyond what `broker_users.role` already stores.** No role editor, no permission matrix. Read `role`, do not build an authorization framework around it.
- **Password authentication, OAuth, SSO, MFA.** Magic link only.
- **A `conversations.status` transition history table** (P8) — the "at close" metric ships as a current-state snapshot.
- **Producing the extraction-result envelope.** C1 reads and displays it; B2 owns producing it.
- **A shared frontend preset in `packages/config`** (P7).
- **Realtime / websockets / push.** Poll or refresh on navigation.
- **Broker-facing customer views, policy CRUD, renewal manipulation.** The dashboard observes and corrects extractions; it does not become an admin console for the whole domain in v1.
- **Dashboard usage-event instrumentation.** H1's metric compares `conversations.kind = 'copilot'` against "eventos del dashboard" — those events do not exist. v1 reports the copilot side and states the denominator gap.

## Capabilities

### New Capabilities

- `broker-auth`: email magic-link issuance, token consumption, session lifecycle, server-side tenant resolution from session, logout.
- `extraction-review`: the `needs_review` queue — list, inspect, correct, resolve.
- `product-metrics`: the 6 §12 metrics as queries + read endpoints, including empty-state semantics.
- `dashboard-app`: the `apps/dashboard` SPA — build pipeline, routing, auth-gated shell, static-bundle deploy contract.

### Modified Capabilities

- `data-model`: adds `broker_users.email` and the `magic_link_tokens` table. Both are spec-level (they define who can authenticate and how a link is invalidated), so both need a delta spec.

## Approach

**Auth flow.** `POST /auth/magic-link {email}` → look up `broker_users` by email → generate a high-entropy random token → store **only its hash** in `magic_link_tokens` with `expires_at` → email the raw token as a link → **always respond 202 with the same body regardless of whether the email matched**, so the endpoint is not an account-enumeration oracle. `GET|POST /auth/callback?token=…` → hash the presented token → look up an unused, unexpired row → set `used_at` → issue the session cookie → redirect. Tokens are single-use; consumption and expiry are both checked server-side, never trusted from the client.

**Every subsequent request** resolves `broker_user_id` → `broker_id` from the session cookie and runs its query inside `withBrokerContext(brokerId, …)`. No dashboard endpoint accepts a `brokerId` parameter. This is F2's tenant-resolution lesson, restated for humans.

**Metrics** are a query module in `apps/api` behind read endpoints, one per metric, each returning a shaped result plus an explicit empty-state marker so the UI distinguishes "zero" from "no data yet" — a distinction that matters enormously right now, when every table is genuinely empty.

**The SPA** is a plain Vite + React build. `apps/dashboard` gains its own `vite.config.ts`, `package.json` dependencies and `build` script producing `dist/`, which Caddy serves. It talks to `apps/api` over REST with credentialed requests.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/dashboard/**` | New | First frontend app: Vite + React, routing, auth shell, review queue, metrics panels |
| `apps/api/src/routes/auth/*.ts` | New | Magic-link request, callback, logout |
| `apps/api/src/routes/dashboard/*.ts` | New | Review queue + metrics read endpoints |
| `apps/api/src/middleware/session-auth.ts` | New | Cookie session verification + tenant resolution |
| `apps/api/src/middleware/admin-auth.ts` | Modified/Removed | Its own docstring's stated expiry condition is now met |
| `apps/api/src/services/metrics/*.ts` | New | The 6 §12 metric queries |
| `packages/db/src/schema/broker_users.ts` | Modified | New `email` column |
| `packages/db/src/schema/magic_link_tokens.ts` + migrations | New | Token table |
| `packages/integrations/src/email/*` | New | Transactional email client |
| `packages/integrations/src/langfuse/*` | New | Cost metric source (P6) |
| `packages/schemas` | Modified | Extraction-result envelope stub (P9) + auth request schemas |
| `apps/api/package.json` | Modified | Cookie signing/session dependency |
| `openspec/ROADMAP.md`, `openspec/PHASES.md` | Modified | Correct C1's `(ff)` tag; record phase state |

## Product Decisions

Settled before this proposal. Inputs to spec and design, not open questions.

- **P1 — Login is an email magic link. WhatsApp magic link was considered and rejected.** This deserves recording, because the entire rest of this product is WhatsApp-first and a future reader will otherwise assume the choice was an oversight. `broker_users.phone` already exists and every broker uses WhatsApp daily, so a WhatsApp login link looks like the obvious answer. It is not: a login link is a **business-initiated message sent outside any active 24-hour session**, which per `docs/ARCHITECTURE.md` §11 requires an **approved HSM template**. That silently re-couples C1 to A2's exact external blocker — Meta template approval — which is the specific reason C1 was chosen over A2 and B2 in the first place. Email has no such gate. The cost is honest: it introduces a new external dependency (P5) and a new column (P2). Both are cheap and under our control. Waiting on Meta is neither. Revisit WhatsApp login only once a login-purpose HSM template is already approved for other reasons.

- **P2 — `broker_users.email` is nullable in the schema and required only to use the dashboard.** Nullable because no existing broker user has one and a `NOT NULL` column with no default cannot be added to a populated table without a fabricated backfill. Required at the application boundary because a magic link needs somewhere to go. The WhatsApp-only flows already shipped (F2's ingress, A1's import) must keep working for users with `email IS NULL` — a broker user without an email is a valid WhatsApp-side actor who simply cannot log in to the dashboard. Add a `UNIQUE (broker_id, email)` constraint mirroring the existing `UNIQUE (broker_id, phone)`; whether email must be globally unique is **NEEDS CONFIRMATION** (see O2).

- **P3 — `magic_link_tokens` stores a hash, never the raw token.** Columns: `id`, `broker_id`, `broker_user_id`, `token_hash`, `expires_at`, `used_at` (nullable), `created_at`. `broker_id` is present because **every table in this schema carries one** — multi-tenant from line one is this project's convention, and RLS applies uniformly. `token_hash` because a magic link is a bearer credential; storing it raw makes a database read equivalent to a login for every pending link. `used_at` follows the nullable-timestamp pattern already used by `contacts.consent_at` — presence means "this happened", and it makes single-use enforceable and auditable rather than implicit in a delete. TTL is **NEEDS CONFIRMATION** (O1); leaning 15 minutes.

- **P4 — Sessions are httpOnly signed cookies, not bearer JWTs.** The deciding factor is that the only client is a browser SPA. A bearer JWT must be stored somewhere JavaScript can read, which makes any XSS a credential theft; an httpOnly cookie is unreadable from JS by construction and is attached by the browser automatically. JWT's real advantages — statelessness across independent services, non-browser clients — do not apply: there is one API, one frontend, and the request is already hitting the database to resolve `broker_id` anyway, so "stateless" buys nothing. Set `httpOnly`, `Secure`, `SameSite=Lax` (Lax, not Strict, so the magic-link redirect from an email client carries the cookie), and sign it. CSRF protection is required and belongs to design.

- **P5 — Transactional email is a new `packages/integrations` client.** No email provider integration exists anywhere in this codebase. It goes in `packages/integrations` because that package holds third-party *service* clients (Chatwoot), which is exactly what this is. The specific provider is **NEEDS CONFIRMATION** and has no architectural stakes — the interface is `sendMagicLink(to, url)`. Deliverability, not API shape, is the real selection criterion.

- **P6 — Build the full metrics layer now; do not split C1 into per-track slices.** `ROADMAP.md` says C1 "can be built incrementally… split into two slices if either track lags." That advice assumes one track lags while the other is ready. **Both lag equally**, so slicing by track partitions zero into zero and produces two changes where one suffices. Five of the six metrics are queryable today against columns that already exist (`conversations.kind`, `renewals GROUP BY status`, `extractions.needs_review`'s partial index, `conversations.status`, and `messages.type = 'template'` + `brokers.created_at` for time-to-first-renewal). They return correct empty results now and real numbers the moment rows arrive, with no code change. The one genuine exception is **cost (USD per conversation/renewal), which requires a Langfuse API integration that does not exist in `packages/integrations`** — new external work, not a query. If schedule pressure forces a cut, cut *that metric*, not a track.

- **P7 — `apps/dashboard` owns its build config standalone. No shared preset in `packages/config`.** A Vite/React preset with exactly one consumer is a guess about a second consumer that does not exist. Extract it when the second frontend app appears and the real commonality is observable, consistent with this project's stated aversion to speculative abstraction.

- **P8 — "% conversations resolved without human" ships as a current-state snapshot, and the proposal says so out loud.** §12 specifies `conversations.status` **al cierre** (at close). There is no event-history table for status transitions anywhere in the schema, so "at close" is unrecoverable — a conversation that was escalated to a human and later closed as resolved is indistinguishable from one that never involved a human. v1 reports the distribution of current `status`, labelled in the UI as a current-state snapshot, **not** as the §12 metric. Adding a `conversation_status_events` table is the correct fix and is a separate change with its own migration and write-path cost; recording the gap here is what keeps it from being quietly forgotten. See O4.

- **P9 — C1 defines a minimal Zod envelope stub for extraction results.** `extractions.output` and `extractions.confidence` are untyped `jsonb` and **no schema anywhere models the per-field `{ value, confidence }` envelope** — B1 defined document *parsing* schemas (carátula, cédula, tarjeta de propiedad), not the extraction result wrapper, and B2, which would naturally own it, does not exist. Rendering opaque JSON in the review queue was the alternative and is rejected: a review queue whose entire purpose is showing a human which *fields* fell below 0.85 confidence cannot do its job against an unparsed blob. The stub is minimal and explicitly provisional — roughly `Record<fieldName, { value: unknown; confidence: number }>` — lives in `packages/schemas`, and is annotated as owned by B2 on arrival. C1 only *reads* this shape; defining a read-side contract for data that does not yet exist is cheap and revisable, and B2 changing it is a normal spec delta, not a breakage.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Magic-link emails land in spam, making login unreliable for pilot brokers | **High** | Provider selection weighted on deliverability (P5); SPF/DKIM/DMARC configured before pilot; a documented operator fallback for issuing a session out-of-band during the pilot |
| The extraction envelope stub (P9) turns out wrong when B2 actually produces data | Med | Stub is explicitly provisional and read-only; the review queue must degrade to raw-JSON display rather than crash on a shape it does not recognize |
| Magic-link token leaks via email forwarding, referrer, or browser history | Med | Short TTL (O1), single-use `used_at`, hashed at rest (P3), token consumed via a request that immediately redirects without the token in the resulting URL |
| Session cookie introduces CSRF on state-changing dashboard endpoints | Med | Inherent to P4 and accepted knowingly; `SameSite=Lax` plus explicit CSRF defense on mutations is a **required design deliverable**, not an implementation detail |
| Metrics are built and validated against entirely empty tables | **High** | Unavoidable — both source tracks are blocked. Every metric query must have a seeded-fixture test with non-empty data, so correctness does not depend on real rows arriving |
| Langfuse cost integration is larger than the other five metrics combined | Med | Isolated as its own work unit; droppable without affecting the other five (P6) |
| Removing `admin-auth.ts` breaks A1's import endpoint, which has no other caller | Med | Decide explicitly in design whether `/admin/policies/import` moves behind the session or stays a machine endpoint. **Do not delete the middleware without answering this** |
| First frontend app in the monorepo brings unplanned tooling burden (lint, typecheck, CI) into existing pipelines | Med | Treat build/lint/CI wiring as explicit tasks, not incidental. `pnpm -r typecheck` and `pnpm -r test` must stay green |
| Review-budget overrun: a new app + new auth + new table + 6 metrics far exceeds 400 changed lines | **High** | `sdd-tasks` must forecast chained PRs. Natural slices: (1) schema + migration, (2) email integration, (3) auth flow, (4) SPA shell, (5) review queue, (6) metrics |

## Rollback Plan

Revert the commit range; run the migration down path (`DROP TABLE magic_link_tokens`, `ALTER TABLE broker_users DROP COLUMN email`). Both are additive — dropping them loses only pending login tokens and stored emails, no domain data. `apps/dashboard` returns to an empty shell and Caddy serves nothing at that path. **The one non-mechanical step**: if `admin-auth.ts` was removed, reverting must restore both the middleware *and* its `ADMIN_API_TOKEN` env var, or A1's import endpoint becomes unreachable. Ordering matters — write it into the change notes rather than improvise it under pressure.

## Dependencies

- `scaffold-monorepo` (F1) — applied. `extractions`, `renewals`, `conversations`, `messages`, `broker_users` all exist.
- `whatsapp-webhook-ingress` (F2) — applied. `tenant-resolver.ts` and the `env.ts` `readRequired` pattern are borrowed directly.
- `policy-bulk-import` (A1) — applied. Owns `admin-auth.ts`, which this change supersedes.
- **New external**: a transactional email provider account with a verified sending domain (P5).
- **New external**: Langfuse API access for the cost metric (P6).
- **Not blocking**: A2 and B2. Their absence makes metrics empty, not wrong.
- `LIVE_TEST_DATABASE_URL` for migration and RLS-scoped tests, per `packages/db/test/migrations/live-rls-verification.test.ts`.

## Open Questions

- **O1** — Magic-link TTL. Leaning **15 minutes**; short enough that a forwarded email is usually dead, long enough to survive a slow mail queue. **NEEDS CONFIRMATION.**
- **O2** — Is `broker_users.email` unique per broker or globally? `UNIQUE (broker_id, email)` mirrors the existing phone constraint, but login starts from an email with no broker context, so a globally duplicated email makes "which broker_user is this?" ambiguous. Leaning **globally unique**. **NEEDS CONFIRMATION.**
- **O3** — Email provider (P5). No architectural stakes; pick during design or apply. **NEEDS CONFIRMATION.**
- **O4** — Does the `conversation_status_events` history table become its own roadmap entry now, or wait until a broker actually asks for the "at close" number? (P8.)
- **O5** — Does `/admin/policies/import` move behind the session, or stay a machine endpoint with `admin-auth.ts` retained for non-browser callers? Design decides; the rollback plan depends on the answer.
- **O6** — Session lifetime and renewal: absolute expiry, sliding window, or refresh-on-use? Distinct from O1 — that is the link, this is the session.
- **O7** — Does `broker_users.role` gate anything in v1 (e.g. `agent` cannot see cross-broker metrics), or is every authenticated user equal within their broker? Leaning **equal in v1**, with `role` read but not enforced.
- **O8** — H1's metric needs "eventos del dashboard" as its denominator and no such instrumentation exists. Is a minimal dashboard-event counter in scope, or does H1 ship half-measured with the gap disclosed? Currently scoped **out**; flagging because it makes one of the six metrics structurally incomplete, not merely empty.

## Product Decisions — Round 2

Settled to unblock `sdd-spec`/`sdd-design` without re-litigating in those
phases — these are the low-stakes calls; the genuinely architectural ones
(session shape, envelope stub) are already decided above and stay there.

- **O1 resolved — 15-minute TTL.** As leaned: short enough that a forwarded
  or leaked email is usually dead, long enough to survive a slow mail queue.
- **O2 resolved — `broker_users.email` is globally unique**, not
  `UNIQUE(broker_id, email)`. Login starts from an email address with no
  broker context yet — that is the whole point of the flow — so a
  broker-scoped uniqueness constraint would leave "which `broker_user` is
  this?" genuinely ambiguous for a duplicated address across two brokers.
  This deliberately diverges from `phone`'s `UNIQUE(broker_id, phone)`
  pattern because the two columns serve different roles: `phone` identifies
  a person within a broker's book of business; `email` is a login credential
  looked up before any broker is known. Different constraint, different job.
- **O3 resolved — provider TBD at apply time, no architectural stakes.**
  Whichever transactional email API is chosen lives in `packages/integrations`
  alongside `chatwoot.ts`, not inline in `apps/api`, matching this project's
  existing convention of keeping third-party service clients in one place.
- **O4 resolved — no new roadmap entry now.** The `conversation_status_events`
  history table stays a documented gap (P8), not a commitment. Building it
  speculatively, before any broker has asked for the true at-close number, is
  exactly the premature-abstraction this project avoids elsewhere.
- **O5 resolved — `admin-auth.ts` stays as-is; `/admin/policies/import` does
  NOT move behind the session in this change.** A1 already shipped, verified,
  and archived that endpoint against the shared-token model. Moving it is a
  second change's job if a real need for browser-driven bulk import ever
  surfaces — pulling it into C1 would touch a closed, verified surface for
  no requirement this change actually has.
- **O6 resolved — sliding session, 7-day idle timeout, renewed on use.**
  A broker checking the dashboard occasionally shouldn't be logged out
  between visits; an abandoned session should still expire eventually.
  Matches the informal trust level of a small admin tool over a bank-grade
  timeout policy this product doesn't need yet.
- **O7 resolved — `role` is read but not enforced in v1.** Every
  authenticated `broker_user` sees everything scoped to their own broker;
  no cross-role restriction exists yet. Enforcing a permission model with a
  single real role in use today (`agent`, per the schema's default) would be
  designing against a hypothetical second role that doesn't exist.
- **O8 resolved — H1 ships disclosed-incomplete, not blocked.** Building a
  dashboard-event counter solely to manufacture a denominator this metric
  doesn't otherwise need is scope creep in the wrong direction. The panel
  states plainly that the denominator is not yet instrumented, rather than
  either fabricating a number or silently dropping the metric.

## Success Criteria

- [ ] A `broker_users` row with an email can request a link, receive it, click it, and land authenticated in the dashboard.
- [ ] A magic-link token cannot be used twice; a second use is rejected. Proven by test.
- [ ] An expired token is rejected. Proven by test.
- [ ] `magic_link_tokens` never contains a raw token — asserted against the actual stored column, not just the code path.
- [ ] Requesting a link for an unknown email returns the **identical** response to a known one. Proven by test (no enumeration oracle).
- [ ] **Non-negotiable**: a live test proves an authenticated broker A session cannot read broker B's extractions, renewals, or metrics — with a positive control proving the assertion is not vacuous.
- [ ] **Non-negotiable**: no dashboard endpoint accepts `brokerId` from the client. Verifiable by inspection of every route's input schema.
- [ ] The review queue lists `extractions WHERE needs_review`, shows per-field values and confidences, and clearing the flag persists — proven against seeded fixture data, since no real extractions exist.
- [ ] All 6 §12 metrics have an endpoint. Five return correct values against seeded fixtures **and** correct empty-state values against empty tables. The cost metric either works or is explicitly disclosed as deferred.
- [ ] The "resolved without human" panel is labelled a current-state snapshot in the UI, not as the §12 at-close metric (P8).
- [ ] `apps/dashboard` builds to `dist/` and the bundle runs against `apps/api` end-to-end.
- [ ] `pnpm -r typecheck`, `pnpm -r test`, `pnpm run lint` and `pnpm run lint:deps` all pass with the new app in the workspace.
- [ ] `ROADMAP.md` C1 no longer claims `(ff)`.
