# DIRUS — SDD Change Roadmap

Maps the build order in `docs/ARCHITECTURE.md` section 13 to a planned sequence of SDD changes. This is a living plan — update it as changes are proposed, applied, or reordered. It does not replace `openspec/changes/{change-name}/proposal.md`; each change still runs its own SDD cycle (or fast-forward) when started.

## Legend

- **ff** — fast-forward: small, low-risk, mechanical enough to skip the full propose→spec→design cycle (still needs tasks + apply + verify).
- **full** — full SDD cycle: propose → spec → design → tasks → apply → verify → archive.

## Structure: two independent tracks

After the foundation is in place, the roadmap splits into **two tracks that do not block each other**. This is deliberate.

Track A validates **H2 (renewals)** and Track B validates **H3 (extraction)**. Each carries its own external blocking precondition — HSM template approval for A, golden dataset collection for B — and neither of those blockers should be allowed to gate the other track. Serializing them would put the highest-value business hypothesis (H2) behind an external dependency it does not actually need.

The key enabler is `policy-bulk-import`: the Renewal Agent needs rows in `policies` with an `end_date` and rows in `contacts` with a phone number. It does not need the multimodal extraction pipeline to work. Brokers already keep their book of business in a spreadsheet — importing it seeds the renewal engine on day one.

---

## Foundation (blocks everything)

### F1. `scaffold-monorepo` (ff)

- **Scope**: pnpm workspaces setup, `packages/db` with the Drizzle schema from `docs/ARCHITECTURE.md` §7.1, initial migrations against Neon.
- **Depends on**: nothing. Blocks every other change.
- **Notes**: no application logic — schema + tooling only. Test runner selection happens here.

### F2. `whatsapp-webhook-ingress` (full) — **DONE** (archived 2026-09-04)

- **Scope**: webhook wired to `apps/api`; tenant resolution by `wa_phone_number_id`; dedup by `wa_message_id`; echo response. Assumes Chatwoot already exists and POSTs at us — Chatwoot's own deployment on the VPS is an infrastructure workstream (no spec, no test, no diff), tracked outside SDD.
- **Depends on**: `scaffold-monorepo`.
- **Status**: Completed. Verify report: PASS (0 CRITICAL, 0 WARNING, 2 disclosed SUGGESTIONs: O3 Chatwoot HMAC unconfirmed, O4 Chatwoot payload shape @provisional). All 63 of 64 tasks complete (4.8 intentionally deferred pending O4). Ready for A2 and B2 with O4 follow-up.
- **Hard requirements**: webhook idempotency (`wa_message_id UNIQUE`) and multi-tenant isolation (`broker_id` + RLS) verified with integration tests. Live test proves tenant X cannot read tenant Y's rows (non-negotiable requirement met). CI runs 33899572167 (Phase 1 gate) and 33922648316 (Phase 6, final) both green.
- **Defect found post-archive, now fixed**: see F2.1 (done). O4 (payload shape `@provisional`) turned out to be a live defect, not a documentation gap — resolved.

### F2.1. `fix-chatwoot-tenant-resolution` (full) — **ARCHIVED** (2026-09-07)

- **Scope**: corrected two always-fatal defects in F2, confirmed against a real self-hosted Chatwoot instance (`infra/chatwoot/`). `inbox.phone_number` never existed in any real payload, so the tenant key could never be extracted; there was also no top-level `contact` field. Replaced the resolution key with `account.id` → `brokers.chatwoot_account_id` (the fallback F2's design D-6 had already named), integer-typed end-to-end, via new migration `0007_chatwoot_account_resolution.sql`. Closes F2's O4 and its deferred task 4.8 — the fixture is now a real captured payload, not a guess.
- **Depends on**: `whatsapp-webhook-ingress` (archived — this corrects it).
- **Status**: Completed, live-verified, and archived. Migration `0007` proven against a real non-superuser Neon connection (task 1.5 hard gate) — this run additionally found and fixed two defects the design phase didn't predict: (1) drizzle-orm's `migrate()` reads its file list from `migrations/meta/_journal.json`, not the directory, so a hand-written migration missing its journal entry silently no-ops; (2) `REVOKE ALL ... FROM PUBLIC` fails silently (no exception) when the executing role lacks grant-option provenance on that ACL entry — confirmed this also affected F2's and `admin-dashboard`'s (C1) already-shipped `0004`/`0006` migrations, whose `PUBLIC EXECUTE` grants were live-exposed on the developer's real database until this session's fix. A genuine end-to-end proof closed Success Criteria item 5 (the one F2 could never evaluate): a real message sent through the running Chatwoot instance resolved the correct broker and persisted one `messages` row; a synthetic unknown-`account.id` request was refused with a clean 404 and an operational log containing only `chatwoot_account_id`, no message content. Verify report: PASS (0 CRITICAL, 1 WARNING). Delta specs merged into main specs (supersession, not addition — all `wa_phone_number_id`-based resolution requirements removed).
- **Notes**: full cycle, not `(ff)`, as planned — it changed a security-critical `SECURITY DEFINER` function and its column-scoped grant, and superseded merged requirements in both `specs/webhook-ingress/spec.md` and `specs/data-model/spec.md`. `0004_tenant_resolver.sql` stayed byte-identical to its archived state throughout.
- **Unblocks**: A2 and B2, which both build on an ingress path that could not previously receive a real message.

---

## Track A — Renewals (validates H2)

### A1. `policy-bulk-import` (ff) — **DONE** (archived 2026-09-05)

- **Scope**: CSV/Excel import to seed `contacts` and `policies` from a broker's existing book of business. Column mapping, validation against the Zod policy schema, idempotent re-import (upsert by `broker_id` + `policy_number`).
- **Depends on**: `scaffold-monorepo`.
- **Status**: Completed. Verify report: PASS (0 CRITICAL, 2 disclosed non-blocking findings: WARNING about apply-progress.md being stale relative to CI history, SUGGESTION about mutation test for consent invariant not yet executed). All 7 phases complete (Phase 1 gate passed in CI run 33971129508; every live suite in the change ran green with 0 skips by the final merge). `policies` and `contacts` are now seedable from a broker's spreadsheet — A2 can build against real data as soon as its own HSM precondition clears.
- **Notes**: **requires a schema change.** `policies.policy_number` is nullable with no unique constraint anywhere; idempotent upsert by `(broker_id, policy_number)` is impossible without a new migration adding a partial unique index (`CREATE UNIQUE INDEX ... ON policies (broker_id, policy_number) WHERE policy_number IS NOT NULL`), shipped in this change's Phase 1. `policies` and `contacts` themselves already exist in §7.1 — the tables were never missing, the constraint was.
- **Hard requirement — Habeas Data**: importing a spreadsheet does **not** grant consent under Ley 1581. `contacts.consent_at` cannot be backfilled from an import. A1 satisfies its half of this invariant — the import path never writes `consent_at` under any code path, verified by a live test. A2 (`renewal-agent`, not yet built) still owns the other half: defining and implementing how consent is actually captured before the first proactive HSM goes out (e.g. consent obtained in the first outbound template, recorded on reply). Proactive messaging to imported contacts without that consent path remains a legal blocker.

### A2. `renewal-agent` (full)

- **Scope**: Mastra `suspend/resume` workflow per policy, daily cron (30 days before `end_date`), HSM template messaging, Wompi/Mercado Pago payment links, escalation to Chatwoot (`bot → open`), state machine `pending → contacted → negotiating → payment_sent → paid | escalated | lost`.
- **Depends on**: `whatsapp-webhook-ingress`, `policy-bulk-import`.
- **Explicitly does NOT depend on**: `ingestion-agent`. Policy data arrives via bulk import; the extraction pipeline is a separate source that can land later.
- **Validates**: H2 (>25% increase in early renewals), measured by `renewals GROUP BY status`.
- **BLOCKING PRECONDITION**: Meta HSM template approval. Must be submitted week 1 (parallel workstream, see below) — external approval latency is on the critical path for this change and for nothing else.

---

## Track B — Ingestion (validates H3)

### B1. `extraction-schemas` (ff) — **DONE** (archived 2026-09-04)

- **Scope**: Zod schemas in `packages/schemas` for carátula (policy cover page), cédula (national ID), tarjeta de propiedad (vehicle registration card).
- **Depends on**: `scaffold-monorepo`.
- **Status**: Completed. Verify report: PASS (0 CRITICAL, 2 disclosed non-blocking WARNINGs). All 20 tasks complete (15 original + 5 fix batch). Ready for B2.

### B2. `ingestion-agent` (full)

- **Scope**: multimodal extraction agent (Gemini via AI SDK), Langfuse tracing, per-field confidence thresholds (0.85), `needs_review` re-ask flow, Flash→Pro escalation on Zod validation failure.
- **Depends on**: `extraction-schemas`, `whatsapp-webhook-ingress`.
- **Validates**: H3 (>95% field-level extraction precision), measured by per-field precision/recall against the golden dataset.
- **BLOCKING PRECONDITION**: at least 20 real broker documents/audios collected as the initial golden dataset. **This change is not startable until that dataset exists.** Calibrating the 0.85 threshold against clean self-taken photos is self-deception — the dataset must contain real conditions (bad lighting, creased documents, regional accents).

### B3. `broker-copilot` (full)

- **Scope**: voice/chat intents for the broker (delegated ingestion, queries, commands) via `broker_users.phone`.
- **Depends on**: `ingestion-agent` (reuses extraction), `whatsapp-webhook-ingress`.
- **Validates**: H1 (>70% of broker interactions via voice/chat).

---

## Convergence

### C1. `admin-dashboard` (full) — **DONE** (archived 2026-09-07)

- **Scope**: login, extraction review queue (`extractions WHERE needs_review`), the 6 metrics from `docs/ARCHITECTURE.md` §12.
- **Depends on**: `renewal-agent` (Track A) and `ingestion-agent` (Track B) for their respective metrics.
- **Notes**: can be built incrementally — the renewal metrics panel does not need Track B to be complete, and vice versa. Split into two slices if either track lags. Neither of those dependencies actually blocked implementation — this change was built ahead of A2/B2 landing, against seeded fixture data (Phases 5-6), per its own proposal's stated testing approach.
- **Status**: Completed. No longer `(ff)` — the design phase (D-A through D-H) needed the full propose→spec→design→tasks cycle, not a mechanical skip. All 8 phases implemented and verified (magic-link request, callback + session, session middleware + CSRF, review queue, six §12 metrics, the React SPA, and cross-tenant isolation proof). Verify report: PASS (0 CRITICAL, 2 disclosed non-blocking WARNINGs: frontend unit-test gap, live-suite CI-only green signal). All 84 tasks complete. Ready for next phase.

---

## Dependency Graph

```
scaffold-monorepo (F1)
  │
  ├── whatsapp-webhook-ingress (F2)
  │     │
  │     ├──────────────┬──────────────────┐
  │     │              │                  │
  ├── policy-bulk-import (A1)      extraction-schemas (B1)
  │     │              │                  │
  │     └──> renewal-agent (A2)    ingestion-agent (B2) <──┘
  │              [HSM approval]      [golden dataset]
  │                   │                   │
  │                   │                   └──> broker-copilot (B3)
  │                   │                   │
  │                   └───────┬───────────┘
  │                           │
  └───────────────────> admin-dashboard (C1) [Phase 8/8 done]
```

Track A and Track B run in parallel after `whatsapp-webhook-ingress`. Neither track's external blocker gates the other.

---

## Parallel Workstreams (NOT SDD changes, critical path)

These run outside the SDD change pipeline but block or de-risk changes above. Track them separately (issue tracker / project board), not as `openspec/changes/*`.

1. **HSM template submission to Meta** — submit in week 1. Approval latency is external and unpredictable; blocks `renewal-agent` (A2) only. Pre-approved generic templates should be prepared as a fallback (per §14 risk table).
2. **Pilot broker onboarding / golden dataset collection** — onboard 3-5 pilot brokers and collect the first 20 real documents/audios. Blocks `ingestion-agent` (B2) only. Target: 200 documents/audios total for the full golden dataset (§8). Onboarding also yields the spreadsheets that feed `policy-bulk-import` (A1).
