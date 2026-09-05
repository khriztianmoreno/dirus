# Proposal: WhatsApp webhook ingress

## Intent

`apps/api` is an empty shell exporting a constant. Nothing in the repo can receive a message. Every downstream change (A2, B2, B3) assumes inbound WhatsApp traffic already lands in `messages` with a `broker_id` on it, so F2 is the change that turns the F1 schema into a live ingress path.

Two properties must be proven here, not asserted: replayed webhooks must not duplicate rows, and tenant X must not be able to read tenant Y's rows. Both are ROADMAP hard requirements. Getting the second one wrong is a data-leak class bug that every later change inherits silently.

## Scope

### In Scope

- `apps/api` becomes a real Hono service: env loading (fail-loud at startup, mirroring `packages/db/src/internal/client.ts`), `src/routes/health`, `src/routes/webhooks/chatwoot`.
- Inbound authentication on the webhook. `docs/ARCHITECTURE.md` §11 requires signature verification on all inbound webhooks; the ROADMAP's F2 line omits it. **We take it in scope**: no unauthenticated write path ships. The *mechanism* is a design decision (see O3) — Chatwoot's outbound webhooks are not known to be HMAC-signed (**NEEDS CONFIRMATION**), so a shared-secret header may be the honest fallback.
- Tenant resolution: `wa_phone_number_id` → `broker_id`, before any tenant context exists (see R1).
- Deduplication by `messages.wa_message_id UNIQUE` — idempotent on replay, not merely "usually fine".
- Persistence of the inbound message. The schema forces more than the ROADMAP's scope line admits: `messages.conversation_id` is `NOT NULL`, so ingress must upsert a `contacts` row (`UNIQUE (broker_id, phone)`) and find-or-create a `conversations` row before the message insert. All of it inside one `withBrokerContext` transaction.
- Echo response back through Chatwoot (`packages/integrations`).
- Chatwoot webhook payload Zod schema in `packages/schemas` — per `docs/ARCHITECTURE.md` §9 ("Zod compartidos: … webhooks"). It has no workspace deps, so this respects the dependency rule and stays reusable by `apps/jobs`.
- Integration tests for idempotency and cross-tenant isolation, following the live-test conventions already in `packages/db/test/migrations/live-rls-verification.test.ts` (`describe.skipIf(LIVE_TEST_DATABASE_URL)`, throwaway schema, disposable fixture roles, `assertThrowawayDatabase`). Do not invent a second convention.

### Out of Scope

- **Chatwoot's deployment on the VPS.** It is an infrastructure workstream, not an SDD change: no spec, no test, no diff. We assume Chatwoot exists and POSTs at us. The ROADMAP's F2 scope line still reads "Chatwoot deployed on the VPS" and **should be corrected** — that line describes ops work, not this change.
- `infra/` Docker/Caddy/CI, Chatwoot account provisioning, agent-bot registration.
- Any agent routing or queueing. The webhook persists and echoes; it does not think.
- Outbound HSM/template sending → `renewal-agent` (A2).
- Media download to R2 → deferred; media messages persist with `body` metadata and a null `media_r2_key`.
- Chatwoot→DIRUS correction sync (`extractions.corrected_output`) → B2.

## Capabilities

### New Capabilities

- `webhook-ingress`: inbound webhook authentication, tenant resolution by `wa_phone_number_id`, idempotent message persistence, echo reply.

### Modified Capabilities

- `data-model`: **conditional.** If the R1 resolution requires a new role, policy or grant, the RLS surface defined in F1 changes at spec level and needs a delta. If R1 resolves without touching the database, this is empty. `sdd-design` settles it.

## Approach

Thin, synchronous, transactional. One route → verify → parse (Zod) → resolve tenant → `withBrokerContext(brokerId, tx => …)` → upsert contact → find-or-create conversation → insert message (dedup on `wa_message_id`) → echo. `pg` driver only: the Neon HTTP driver has no transactions, so `set_config(..., true)` would no-op and tenant scope would silently evaporate.

Fail closed everywhere: unknown `wa_phone_number_id` → reject, no row written, no tenant guessed.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/api` | Modified | Hono app, env loader, health + webhook routes, tenant-resolver middleware |
| `packages/schemas` | Modified | Chatwoot inbound webhook payload schema |
| `packages/db` | Modified | New public export: a tenant-resolution call that runs *outside* `withBrokerContext` |
| `packages/db/migrations` | Modified (conditional) | Role/policy/grant migration, if R1 requires one |
| `packages/integrations` | Modified | Minimal Chatwoot client for the echo reply |
| `openspec/ROADMAP.md` | Modified | Correct the F2 scope line |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **R1 — resolving a tenant before tenant context exists.** `brokers` has `FORCE ROW LEVEL SECURITY`; the lookup must read `brokers` before any `broker_id` is known, so it fails closed to zero rows. FORCE binds the table owner too (proven by a negative control in `live-rls-verification.test.ts`), which rules out owner-owned `SECURITY DEFINER` functions and non-`security_invoker` views. A permissive `FOR SELECT USING (true)` policy works but ORs away the row filter for `dirus_app` on every `brokers` query — reopening exactly the hole FORCE closed. | High | **This proposal deliberately does not pick a winner.** Exploration §3 names one shape that appears to survive — a role-scoped policy (`TO <dedicated_role>`) plus a `SECURITY DEFINER` function owned by that role returning only a `uuid`, `EXECUTE` granted to `dirus_app`. It is a **hypothesis for `sdd-design` to evaluate and prove with a live test**, not a decision. A design that gets this wrong cannot pass its own non-negotiable isolation test. |
| Whatever R1 chooses, `packages/db` gains a public export that runs outside `withBrokerContext` — a new access class the `tenant.ts` docstring does not account for ("`TenantDb` … is the only tenant-scoped handle callers ever receive"). | High | Design must define its blast radius (returns a bare `uuid`, no table handle) and update the docstring. |
| Chatwoot's real payload shape is unverified — no live instance, no fixture. | High | **NEEDS CONFIRMATION** before spec freeze. Capture a real payload, or derive from Chatwoot docs and mark the schema provisional with a fixture-backed test. |
| Chatwoot may not sign its webhooks, making §11's requirement unsatisfiable as literally written. | Med | Design picks a mechanism and records the compromise explicitly. Never "skip auth for now". |
| Concurrent duplicate webhooks race past a read-then-insert dedup check. | Med | Dedup must rely on the `wa_message_id UNIQUE` constraint (`ON CONFLICT DO NOTHING`), not an application-level pre-read. Test with concurrent delivery, not just sequential replay. |
| `conversations` has no UNIQUE constraint suitable for a find-or-create upsert. | Med | Design decides: add a partial UNIQUE index (→ migration, `data-model` delta) or serialize inside the transaction. Do not leave it to chance. |

## Rollback Plan

Revert the commit range. `apps/api` returns to an empty shell and nothing downstream exists yet to break. If a migration landed, it must be written with a matching down path — a new role/policy/grant is additive and droppable, but the revert order (drop function → drop policy → drop role) must be scripted, not improvised. Chatwoot is unaffected: it keeps POSTing into a 404, which is a stopped ingress, not a corruption.

## Dependencies

- `scaffold-monorepo` (F1) — applied.
- A running Chatwoot instance for end-to-end confirmation (out of scope here; unit/integration tests must not require it).
- `LIVE_TEST_DATABASE_URL` for the isolation and idempotency tests. CI provides `pgvector/pgvector:pg17`.

## Product Decisions

Settled with the product owner during the proposal round. These are inputs to
spec and design, not open questions.

- **P1 — The echo is a fixed acknowledgement, not a literal parrot.** The
  endpoint replies with a fixed Spanish acknowledgement along the lines of
  "Recibimos tu mensaje, ya te respondemos", sent over WhatsApp. Echoing the
  customer's own text back reads as a bug to a real customer, and F2 is meant
  to run against a real pilot number. The copy is a placeholder that A2 and B2
  replace with the actual agent reply; it deliberately promises nothing we
  cannot yet deliver. This closes **O6**.
- **P2 — The raw Chatwoot payload is not retained.** Inbound payloads carry
  cédula numbers and phone numbers. Storing them verbatim for debugging
  conflicts with the PII stance in `docs/ARCHITECTURE.md` §11 and with Ley 1581.
  Only the fields the schema models are persisted.
- **P3 — Media download to R2 is out of scope for F2.** A media message is
  persisted with a null `media_r2_key`. The consequence is accepted and stated:
  an early pilot broker sending a photo produces a row whose content is not yet
  retrievable. Media retrieval belongs with the ingestion agent (B2), which is
  the first change that actually needs to read it.
- **P4 — An unknown `wa_phone_number_id` is logged, not silently rejected.**
  The request is still refused with no rows written and no tenant inferred
  (unchanged), but it emits an operational log line. A silent 4xx makes
  onboarding misconfiguration invisible at exactly the moment a new broker is
  being connected. The log line must not include message content.

- **P5 — A non-`active` broker still resolves; ingestion is not gated on
  `brokers.status`.** The resolver returns the broker id without inspecting
  `status`. Suspending a broker is a commercial matter between us and the
  broker; their customers are not party to it, and dropping those customers'
  inbound messages would destroy data the broker legitimately needs when the
  account is restored. Cutting service, if it ever happens, belongs at the
  outbound/agent layer where it is a visible product decision — not silently
  inside a tenant-resolution predicate, where a suspended broker would be
  indistinguishable from an unknown number.

## Open Questions for Design

- **O1 (blocking)** — R1: which mechanism resolves `wa_phone_number_id` → `broker_id` without weakening `brokers` RLS for `dirus_app`? Must be a design entry proven by a live test before any implementation.
- **O2** — Does R1's resolution require a migration, and therefore a `data-model` delta spec?
- **O3** — Which inbound-authentication mechanism does Chatwoot actually support? Determines whether §11 is met literally or by compensating control.
- **O4** — Exact Chatwoot payload shape (**NEEDS CONFIRMATION**); which events do we accept and which do we ignore?
- **O5** — Find-or-create key for `conversations`: new constraint, or transactional serialization?

## Success Criteria

- [x] A Chatwoot webhook POST resolves the right broker and persists exactly one `messages` row with the correct `broker_id`, `conversation_id` and `contact_id`.
- [x] Replaying the same `wa_message_id` — sequentially and concurrently — leaves exactly one row and still returns 2xx.
- [x] An unknown `wa_phone_number_id` is rejected with no rows written and no tenant inferred.
- [x] An unsigned/unauthenticated request is rejected.
- [x] **Non-negotiable**: a live integration test proves tenant X cannot read tenant Y's `messages`, `conversations` or `contacts` rows, using the existing live-test conventions.
- [x] A live test proves the R1 mechanism does not make arbitrary `brokers` rows readable to `dirus_app`.
- [x] `pnpm -r typecheck` and `pnpm -r test` pass; the dependency rule still holds (`packages/schemas` imports nothing).
