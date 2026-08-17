# DIRUS — Project Context

> Source of truth: `docs/ARCHITECTURE.md` (Spanish, v1.0, Aug 2026). This file is the English SDD-facing distillation every future change must read. Do not contradict `docs/ARCHITECTURE.md`; if this file and the source doc diverge, the source doc wins and this file must be updated.

## Product Thesis

DIRUS is an invisible AI execution engine for Colombian insurance brokerages (corredores de seguros). It is explicitly **not a CRM**. The interface is WhatsApp — voice notes, photos, text — and AI agents execute the operational work (data extraction, renewals, collections, escalation) in the background. Success is measured by how many conversations *never* reach a human inbox.

## Design Principles (settled, do not re-litigate)

1. **The interface is WhatsApp.** Every feature must be operable by chat/voice. A screen exists only when chat cannot resolve it (exceptions and metrics).
2. **Zero-touch by default, human by exception.** Agents resolve ~95% of conversations. Humans see only what requires judgment.
3. **Extraction with confidence, never with guessing.** Every model output passes through a Zod schema + per-field confidence score. Below threshold → the agent re-asks, never invents.
4. **The moat is the dataset, not the model.** Every human correction is a captured asset (data flywheel), by design.
5. **Multi-tenant from line 1.** `broker_id` on every table, Postgres RLS as second defense. A new client is configuration, not code.
6. **Own source of truth.** Third-party tools (Chatwoot) are replaceable operational mirrors. Data lives in DIRUS's own Postgres.

## Architecture Decisions (ADR-1 to ADR-10) — SETTLED

These are closed decisions from `docs/ARCHITECTURE.md` section 3. Future `sdd-design` phases MUST treat them as constraints, not open questions.

| ADR | Decision | Chosen | Rationale |
|---|---|---|---|
| ADR-1 | Agent framework | **Mastra** | Native `suspend/resume` workflows (renewals live for weeks), first-class human-in-the-loop, built-in evals, model-agnostic via AI SDK |
| ADR-2 | Model layer | **Vercel AI SDK** with task-based routing | Swapping models is config, not refactor |
| ADR-3 | WhatsApp channel | **Meta Cloud API via Chatwoot** | No per-message markup; Chatwoot gives inbox, contacts, mobile apps for free |
| ADR-4 | Exception inbox | **Chatwoot Agent Bot** | Saves 4-6 weeks of UI; `bot → open` pattern with full context; own data as source of truth keeps future migration cheap |
| ADR-5 | Queue & cron | **Trigger.dev Cloud** | Long-running jobs, retries, cron, observability without operating Redis |
| ADR-6 | Database | **Postgres (Neon) + Drizzle + pgvector** | Transactional + vectors in one DB; branching for dev; managed backups |
| ADR-7 | AI observability | **Langfuse Cloud** | Self-hosted v3 requires Clickhouse+Redis+S3; free tier is enough for the pilot |
| ADR-8 | Media | **Cloudflare R2** | No egress cost; Meta media IDs expire → immediate download is mandatory |
| ADR-9 | Deployment | **Hetzner VPS (Docker+Caddy) + managed state** | Compute is disposable; state never depends on a VPS volume |
| ADR-10 | Repository | **pnpm monorepo** | Shared types, Zod schemas, and DB client across agents, API, and dashboard |

## Tech Stack

- **Runtime**: Node 22, TypeScript
- **API**: Hono (`apps/api`)
- **Dashboard**: Vite + React (`apps/dashboard`), static build
- **Jobs**: Trigger.dev (`apps/jobs`)
- **ORM**: Drizzle (`packages/db`)
- **Validation**: Zod (`packages/schemas`)
- **Package manager**: pnpm workspaces
- **Agents**: Mastra (`packages/agents`)
- **Models**: routed via Vercel AI SDK — Gemini 3.1 Flash/Pro (multimodal extraction), Gemini 3.5 Flash / Claude Haiku (volume conversation), Claude Sonnet (sensitive drafting, objection handling)

## Monorepo Layout

```
dirus/
├── apps/
│   ├── api/          # Hono: Chatwoot/Meta webhooks, admin REST
│   ├── dashboard/     # Vite + React, static build
│   └── jobs/          # Trigger.dev tasks (renewal-cron, process-media, sync-chatwoot)
├── packages/
│   ├── agents/        # Mastra agents + workflows (ingestion, renewal, copilot)
│   ├── db/            # Drizzle schema, migrations, client
│   ├── schemas/        # Shared Zod schemas (extraction, webhooks, API contracts)
│   ├── integrations/   # Typed clients (chatwoot.ts, meta-wa.ts, wompi.ts)
│   └── config/         # base tsconfig, eslint, constants
└── infra/              # docker-compose (dev/prod), Caddyfile
```

**Dependency rule (hard constraint)**: `apps/*` imports from `packages/*`, never the reverse, and never app-to-app. `packages/schemas` imports nothing — it is the foundation.

## Cross-Cutting Invariants

Every change MUST respect these regardless of feature scope:

- `broker_id` on EVERY table; Postgres RLS (`SET app.broker_id` per request) as second defense against a missing `WHERE`.
- Structured outputs only: `generateObject` (AI SDK) + Zod schemas in `packages/schemas`. Never free-text parsing.
- Per-field confidence scoring on every extraction; threshold **0.85** (initial, calibrated by evals). Below threshold → re-ask the user, never guess. Model escalation Flash→Pro before re-asking.
- Webhook idempotency: `messages.wa_message_id UNIQUE` for dedup. Renewal cron idempotency: `UNIQUE(renewals.policy_id, due_date)`.
- All media downloaded immediately to Cloudflare R2 — Meta media IDs expire.
- Every LLM call traces to Langfuse. No PII in trace metadata — reference by ID only, never cédulas or phone numbers in cleartext.
- Habeas Data (Colombian Ley 1581): `contacts.consent_at` required before processing; documented retention policy for R2 media; deletion-on-request process. Non-negotiable before selling to agencies.
- WhatsApp 24h window: proactive messages (e.g. renewals) require Meta-approved HSM templates. Free-form replies only within the window (`conversations.window_expires_at` governs the decision).

## Validation Hypotheses (measurable acceptance criteria)

| Hypothesis | Metric | Threshold | Source |
|---|---|---|---|
| H1 — invisible interface | % of broker interactions via voice/chat vs. dashboard | **>70%** | `conversations.kind = 'copilot'` vs. dashboard events |
| H2 — renewals | % increase in early renewals vs. broker baseline | **>25%** | `renewals GROUP BY status` |
| H3 — extraction | Field-level extraction precision/recall | **>95%** | Evals on golden dataset + `needs_review` rate |

## Conventions

- Conventional commits.
- English for all code, comments, and documentation artifacts (this doc is the English distillation of the Spanish source `docs/ARCHITECTURE.md`).
- Strict TDD Mode: enabled (per project/global convention).
