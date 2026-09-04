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

### F2. `whatsapp-webhook-ingress` (full)

- **Scope**: Chatwoot deployed on the VPS; webhook wired to `apps/api`; tenant resolution by `wa_phone_number_id`; dedup by `wa_message_id`; echo response.
- **Depends on**: `scaffold-monorepo`.
- **Hard requirements**: webhook idempotency (`wa_message_id UNIQUE`) and multi-tenant isolation (`broker_id` + RLS) must be verified with integration tests before this change is considered done. A test proving tenant X cannot read tenant Y's rows is non-negotiable.

---

## Track A — Renewals (validates H2)

### A1. `policy-bulk-import` (ff)

- **Scope**: CSV/Excel import to seed `contacts` and `policies` from a broker's existing book of business. Column mapping, validation against the Zod policy schema, idempotent re-import (upsert by `broker_id` + `policy_number`).
- **Depends on**: `scaffold-monorepo`.
- **Notes**: requires no schema changes — `policies` and `contacts` already exist in §7.1.
- **Hard requirement — Habeas Data**: importing a spreadsheet does **not** grant consent under Ley 1581. `contacts.consent_at` cannot be backfilled from an import. The change must define how consent is captured before the first proactive HSM goes out (e.g. consent obtained in the first outbound template, recorded on reply). Proactive messaging to imported contacts without a defined consent path is a legal blocker, not a nice-to-have.

### A2. `renewal-agent` (full)

- **Scope**: Mastra `suspend/resume` workflow per policy, daily cron (30 days before `end_date`), HSM template messaging, Wompi/Mercado Pago payment links, escalation to Chatwoot (`bot → open`), state machine `pending → contacted → negotiating → payment_sent → paid | escalated | lost`.
- **Depends on**: `whatsapp-webhook-ingress`, `policy-bulk-import`.
- **Explicitly does NOT depend on**: `ingestion-agent`. Policy data arrives via bulk import; the extraction pipeline is a separate source that can land later.
- **Validates**: H2 (>25% increase in early renewals), measured by `renewals GROUP BY status`.
- **BLOCKING PRECONDITION**: Meta HSM template approval. Must be submitted week 1 (parallel workstream, see below) — external approval latency is on the critical path for this change and for nothing else.

---

## Track B — Ingestion (validates H3)

### B1. `extraction-schemas` (ff)

- **Scope**: Zod schemas in `packages/schemas` for carátula (policy cover page), cédula (national ID), tarjeta de propiedad (vehicle registration card).
- **Depends on**: `scaffold-monorepo`.

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

### C1. `admin-dashboard` (ff)

- **Scope**: login, extraction review queue (`extractions WHERE needs_review`), the 6 metrics from `docs/ARCHITECTURE.md` §12.
- **Depends on**: `renewal-agent` (Track A) and `ingestion-agent` (Track B) for their respective metrics.
- **Notes**: can be built incrementally — the renewal metrics panel does not need Track B to be complete, and vice versa. Split into two slices if either track lags.

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
  └───────────────────> admin-dashboard (C1)
```

Track A and Track B run in parallel after `whatsapp-webhook-ingress`. Neither track's external blocker gates the other.

---

## Parallel Workstreams (NOT SDD changes, critical path)

These run outside the SDD change pipeline but block or de-risk changes above. Track them separately (issue tracker / project board), not as `openspec/changes/*`.

1. **HSM template submission to Meta** — submit in week 1. Approval latency is external and unpredictable; blocks `renewal-agent` (A2) only. Pre-approved generic templates should be prepared as a fallback (per §14 risk table).
2. **Pilot broker onboarding / golden dataset collection** — onboard 3-5 pilot brokers and collect the first 20 real documents/audios. Blocks `ingestion-agent` (B2) only. Target: 200 documents/audios total for the full golden dataset (§8). Onboarding also yields the spreadsheets that feed `policy-bulk-import` (A1).
