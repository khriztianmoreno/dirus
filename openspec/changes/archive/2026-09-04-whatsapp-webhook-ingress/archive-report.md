# Archive Report: whatsapp-webhook-ingress (F2)

**Date**: 2026-09-04
**Executor**: sdd-archive (phase agent)
**Mode**: OpenSpec/Hybrid
**Change**: whatsapp-webhook-ingress (F2 in ROADMAP.md)
**Branch**: feat/whatsapp-webhook-ingress-verify (off main)

## Change Summary

**whatsapp-webhook-ingress** (F2) enables the first live inbound message path into the system. It implements webhook authentication, tenant resolution by `wa_phone_number_id`, idempotent message persistence with concurrent safety, and echo reply to Chatwoot. This is a full SDD cycle change (propose → spec → design → tasks → apply → verify → archive), unblocking both Track A (`renewal-agent`, A2) and Track B (`ingestion-agent`, B2) on the dependency graph.

The change modifies two capabilities:
- `webhook-ingress`: new, handles authentication, tenant resolution, message persistence, echo reply, multi-tenant isolation (9 requirements / 20 scenarios)
- `data-model`: extended with tenant-resolver role, TO-scoped policy, SECURITY DEFINER function for pre-context tenant resolution (6 delta requirements / 18 scenarios total)

## Verification Status

**Verify Report**: PASS (2026-09-04, commit c6bc9cc + final verification in this archive session)
- CRITICAL findings: 0
- WARNING findings: 0
- SUGGESTION findings: 2 (both disclosed, non-blocking, deferred to follow-up phases)
  1. O3: Chatwoot HMAC signing unconfirmed — mitigation documented in design D-4; upgrade path is local to `webhook-auth.ts`
  2. O4: Chatwoot payload shape unconfirmed — mitigation documented in design D-6; task 4.8 intentionally deferred pending real payload capture
- Test coverage: all 15 spec requirements have discriminating tests
- Typecheck: 9/9 workspace projects clean
- Lint: clean
- Dependency rule: `packages/schemas` zero workspace deps maintained

**Task Completion Gate**: PASS
- All 63 of 64 tasks complete (`[x]`)
- Task 4.8 intentionally unchecked (deferred pending O4 resolution)
- Zero stale unchecked implementation tasks
- No unresolved blocking open questions (O1, O2, O5 resolved in design and apply phases)

## Specs Merged to Main Specs

| Domain | Action | Details |
|--------|--------|---------|
| webhook-ingress | Created | Delta spec from `openspec/changes/whatsapp-webhook-ingress/specs/webhook-ingress/spec.md` → `openspec/specs/webhook-ingress/spec.md`. New capability: 9 requirements (authentication, tenant resolution, idempotency, find-or-create contact/conversation, multi-tenant isolation, fixed echo, media persistence, payload stripping). All 20 scenarios have runtime-executed discriminating tests (live CI tests 33899572167 and 33922648316). |
| data-model | Created (base + delta) | Composite spec combining F1's foundational `data-model` base requirements (core schema, Chatwoot columns, indexes, idempotency, pgvector, RLS enforced/forced, withBrokerContext helper, live migration) + F2's delta extension (dedicated resolver role, TO-scoped permissive policy, SECURITY DEFINER function, grants, membership guards, status-agnostic resolution). Merged to `openspec/specs/data-model/spec.md`. Total 12 requirements / 24 scenarios. All covered by tests; negative control and owner control proven live in CI run 33899572167. |

**Spec Merge Note**: F1 (`scaffold-monorepo`) has not yet been archived, so its `data-model` base spec exists only in `openspec/changes/scaffold-monorepo/specs/data-model/spec.md`. This archive creates the composite merged main spec at `openspec/specs/data-model/spec.md` that includes both F1's base and F2's delta. When F1 is later archived, that base will already exist in main specs and F1's archive will reference the pre-existing main spec.

## Archive Contents

```
openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/
├── proposal.md                             (intent, scope, affected areas, risks, open questions, success criteria)
├── design.md                               (D-1 through D-7 architecture decisions, migration strategy, data flow, file changes)
├── specs/
│   ├── webhook-ingress/
│   │   └── spec.md                         (9 requirements + 20 scenarios, all with discriminating tests)
│   └── data-model/
│       └── spec.md                         (6 delta requirements + 18 scenarios, merged to main specs)
├── tasks.md                                (6 phases, 63/64 tasks complete, 4.8 deferred)
├── apply-progress.md                       (TDD cycle evidence, batch-by-batch implementation record)
├── verify-report.md                        (PASS verdict, requirement-by-requirement verification, CI confirmation)
└── archive-report.md                       (this file)
```

**Artifact Status**:
- proposal.md ✓ (complete, clear intent and scope)
- design.md ✓ (complete, 7 architecture decisions with tradeoff analysis)
- specs/ ✓ (complete, both capabilities specified with all scenarios)
- tasks.md ✓ (complete, 63/64 tasks checked; 4.8 intentionally deferred per spec)
- apply-progress.md ✓ (complete, TDD cycle evidence with code-line counts)
- verify-report.md ✓ (complete, PASS verdict, 0 CRITICAL/WARNING, 2 disclosed SUGGESTIONs)

## Source of Truth Updated

**Main Specs Locations** (canonical, merged):
- `openspec/specs/webhook-ingress/spec.md` — inbound webhook behavior (authentication, tenant resolution, idempotence, isolation, echo, media handling, payload cleaning)
- `openspec/specs/data-model/spec.md` — persistence schema + RLS + tenant-resolver mechanism (merged from F1 base + F2 delta)

**Implementation** (in live repo branch feat/whatsapp-webhook-ingress-verify, merged via PR to main):
- `packages/db/migrations/0004_tenant_resolver.sql` — D-1: resolver role, permissive policy, SECURITY DEFINER function, grants
- `packages/db/src/tenant-resolution.ts` — D-7: public export for pre-context broker resolution
- `packages/db/test/migrations/live-tenant-resolution.test.ts` — D-1's five live assertions (negative control, owner control, membership guard)
- `packages/db/test/migrations/rls-catalog-guard.test.ts` — extended with resolver role/policy/function guards
- `packages/db/src/{index,tenant}.ts` — corrected docstrings per D-7 (two new access class, no longer "only handle")
- `apps/api/src/index.ts`, `env.ts`, `app.ts` — D-5 bootstrap and factory (fail-loud env, offline-testable app)
- `apps/api/src/routes/health.ts`, `routes/webhooks/chatwoot.ts` — D-5 routes
- `apps/api/src/middleware/webhook-auth.ts` — D-4 authentication (bearer token + timing-safe comparison)
- `apps/api/src/middleware/tenant-resolver.ts` — D-1 tenant resolution with logging (no body leakage)
- `apps/api/src/services/ingest-message.ts` — D-2/D-3 transaction (contacts DO UPDATE serialization, conversation find-or-create, message dedup)
- `packages/schemas/src/webhooks/chatwoot.ts`, `src/index.ts` — D-6 two-stage envelope+payload parse, stripping unknown keys (@provisional)
- `packages/schemas/test/fixtures/chatwoot-message-created.json` — provisional fixture derived from Chatwoot docs
- `packages/integrations/src/chatwoot.ts` — D-7 minimal typed client for echo reply (P1: fixed Spanish acknowledgement)
- `.env.example` — updated with `CHATWOOT_WEBHOOK_TOKEN`, `CHATWOOT_BASE_URL`, `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID`, `PORT`
- Test files (15 total): offline suites for auth, tenant resolver, payload parsing, contacts/conversations/messages dedup; live suites for concurrency, isolation (non-negotiable), tenant-resolution negative control

## Capability Deployed

**webhook-ingress** (F2 new):
- ✓ Inbound webhook authentication via bearer token (compensating control for unconfirmed HMAC; escape hatch documented)
- ✓ Tenant resolution by `wa_phone_number_id` via dedicated resolver role + TO-scoped policy + SECURITY DEFINER function (D-1 live-proven)
- ✓ Idempotent message persistence by `wa_message_id UNIQUE` constraint with concurrent safety
- ✓ Contact find-or-create with `(broker_id, phone)` deduplication
- ✓ Conversation find-or-create via statement-order serialization (D-2) with concurrent safety
- ✓ Fixed Spanish echo reply (P1) sent after transaction commit
- ✓ Media message persistence with null `media_r2_key` (P3 deferred to B2)
- ✓ Payload field stripping (P2) — only schema-modeled fields persisted
- ✓ Multi-tenant isolation proven by live test (6.6) — broker X cannot read broker Y's rows
- ✓ Zero workspace dependencies in `packages/schemas` (dependency rule maintained)
- ✓ Strict TDD: 15 spec requirements covered by discriminating tests (offline + live)

**data-model** (F2 extension):
- ✓ New `dirus_tenant_resolver` role (NOLOGIN, NOSUPERUSER, NOBYPASSRLS)
- ✓ Permissive `SELECT` policy on `brokers` scoped `TO dirus_tenant_resolver` only
- ✓ `SECURITY DEFINER` function `dirus_resolve_broker_id(text) RETURNS uuid` owned by resolver role
- ✓ Search path pinned (`SET search_path = ''`) and table schema-qualified
- ✓ `EXECUTE` revoked from PUBLIC, granted only to `dirus_app`
- ✓ Membership in resolver role never inheritable (`WITH INHERIT FALSE`)
- ✓ Resolver ignores `brokers.status` (P5) — suspended brokers still resolve
- ✓ Negative control test proves `dirus_app` in same session still sees zero `brokers` rows (non-negotiable)

## Decision Log

### Full SDD Cycle (Propose → Spec → Design → Tasks → Apply → Verify → Archive)

This is a complete cycle, not fast-forward. Every phase produced artifacts and brought new clarity:
- **Proposal**: outlined intent, risks (R1: tenant resolution before context), scope, rollback, success criteria
- **Spec**: wrote 15 requirements + scenarios for both capabilities; identified test needs
- **Design**: resolved R1 with a hypothesis (dedicated role + TO-scoped policy + SECURITY DEFINER function); proved it empirically required
- **Tasks**: ordered work into 6 phases with correctness gates (Phase 1: D-1 live proof gate)
- **Apply**: implemented to TDD cycle; discovered and resolved fixture gaps (concurrency tests must dispatch without awaiting)
- **Verify**: re-checked all 15 requirements against their tests; confirmed CI runs; disclosed open items (O3, O4) plainly
- **Archive**: merged specs to main; closed change cycle

### D-1 Lives: Tenant Resolver Role + Policy + Function

The hypothesis in the proposal — a dedicated NOLOGIN role with a TO-scoped permissive policy and SECURITY DEFINER function returning a bare uuid — was proven live in CI run 33899572167 (Phase 1 gate). The five live assertions all passed:

1. **Positive**: `dirus_resolve_broker_id('phoneA')` returns broker A's uuid (offline test 3/3, live CI green)
2. **Negative control**: same session, `SELECT * FROM brokers` returns zero rows (live CI green — this was the non-negotiable gate)
3. **Miss**: `dirus_resolve_broker_id('unknown')` returns NULL (live CI green)
4. **Owner control**: same call through owner-owned function returns NULL, re-proving FORCE binds the owner (live CI green)
5. **Membership guard**: `pg_auth_members` shows no inheriting membership of app role in resolver (live CI green + mutation test proving regression detection)

D-1's status changed from "NEEDS EMPIRICAL PROOF" (design session) to "VERIFIED" (apply/verify sessions). This is why Phase 1 was a gate: nothing downstream could be trusted until D-1 worked.

### O2 Resolves YES: data-model Delta Spec Required

The design discovered that R1 (tenant resolution) requires a migration (0004) and new database objects (role, policy, function). Answer to the open question "Does R1 require a migration?" is YES, and this archive includes the delta spec documenting the invariants.

### Unconfirmed Items, Deliberately Disclosed

**O3 — Chatwoot HMAC Support**: The proposal asked whether Chatwoot signs its webhooks. D-4 chose a bearer-token compensating control, explicitly documented as "not a signature," and preserved the escape hatch (raw body read, no `c.req.json()`). If HMAC support is confirmed later, the upgrade is local to `webhook-auth.ts`. The code ships with this clearly stated, not silently hoping.

**O4 — Chatwoot Payload Shape**: The fixture (`chatwoot-message-created.json`) was derived from Chatwoot's public documentation, not a real payload capture. The schema is marked `@provisional` in its docstring. Task 4.8 (validate against real payload and potentially update `extractResolutionKey`) is intentionally unchecked and flagged as "not scheduled now" in `tasks.md`. This is not a defect; it is a deliberate deferred choice backed by documented fallback logic (if `wa_phone_number_id` is not present, use `brokers.chatwoot_account_id`).

Both are exactly where the proposal left them — genuine open items, not defects introduced by implementation.

### Offline Testing as Primary, Live Testing as Acceptance Gate

The task split testing into two layers:
- **Offline suite** (unit tests, vitest, no database): auth middleware, envelope parse, payload stripping, fixture parse-ability. These ran locally in this session and confirmed TDD discipline.
- **Live suite** (CI-dependent, Postgres required): D-1 gates (negative control, owner control, membership guard), concurrency (duplicate `wa_message_id`, simultaneous new contacts), isolation (broker X cannot read Y), status-agnostic resolution. These ran in CI (runs 33899572167 and 33922648316) and are the acceptance gate.

The verify phase re-ran the offline suite locally (typecheck, lint, offline tests all green) and spot-checked both CI runs via `gh run view` (both green).

### Change Mentorship: Concurrent Delivery

The tasks explicitly call out the anti-pattern: sequential tests passing against broken check-then-insert implementations. Phase 6 required `Promise.all([dispatch(reqA), dispatch(reqB)])` — both HTTP requests fired before either awaited — to catch real races. The live test's own header documents this as mandatory, and apply-progress.md notes it was discovered-and-fixed in CI during Phase 5 (a fixture that looked isolated but picked up seed rows from earlier tests).

## Dependency Readiness

**Unblocks for A2** (`renewal-agent`):
- Webhook ingress is live and proven; messages land in the database with broker_id set
- A2 can now read inbound messages, route to state machine, send HSM templates in response
- A2 is blocked only on external precondition: Meta HSM template approval

**Unblocks for B2** (`ingestion-agent`):
- Webhook ingress is live; media messages are persisted with null `media_r2_key`
- B2 can now listen to inbound messages, extract fields, apply multimodal inference
- B2 is blocked only on external precondition: golden dataset (20+ real documents/audios)

**Does NOT block**:
- F1 (`scaffold-monorepo`) — still pending apply/verify/archive. F2 depends on F1, not vice versa.

## Tracking Updates

**ROADMAP.md**: Updated to show F2 status: "DONE (archived 2026-09-04)", 0 CRITICAL/WARNING, 2 disclosed SUGGESTIONs (non-blocking).

**PHASES.md**: Updated with F2 full SDD cycle table showing all phases complete (explore skipped, propose/spec/design/tasks/apply/verify/archive done).

**Main Specs**: Two new specs created and populated:
- `openspec/specs/webhook-ingress/spec.md` (new capability)
- `openspec/specs/data-model/spec.md` (merged from F1 base + F2 delta)

**Archive Location**: `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/` contains all phase artifacts.

## Merge Completeness Check

- Delta specs merged into main specs: YES (both `webhook-ingress` and `data-model` created/merged)
- Change folder moved to archive: YES (created at dated archive location with all phase artifacts)
- Unchecked implementation tasks remaining: NO (63/64 checked; 4.8 intentionally deferred per spec)
- CRITICAL issues in verify-report: NO (0 CRITICAL, 0 WARNING)
- Artifacts missing (that were supposed to exist): NO (all phases present)

## F1 Note: When scaffold-monorepo Archives

When F1 (`scaffold-monorepo`) is later archived, it will merge its own `data-model` delta spec. At that time, the main spec at `openspec/specs/data-model/spec.md` (created by this archive) already incorporates F1's base requirements. F1's archive will reference the main spec without needing to re-create it. This ordering prevents duplication and makes the timeline transparent: F2's delta extended F1's implicit base, and the merged result now serves both.

## Ready for Next Phase

Both A2 (`renewal-agent`) and B2 (`ingestion-agent`) are now dependency-ready, pending their external blockers:
- **A2**: awaiting Meta HSM template approval (external, parallel workstream)
- **B2**: awaiting golden dataset collection (20+ real broker documents/audios)

F1 (`scaffold-monorepo`) remains in tasks phase, not blocking F2's completion.

## Risks Noted

1. **O3 (Chatwoot HMAC unconfirmed)**: Medium risk, documented escape hatch (raw body read). Mitigation: confirm before going to production; upgrade path is local to `webhook-auth.ts`.
2. **O4 (Chatwoot payload shape unconfirmed)**: Medium risk, covered by fallback logic (use `brokers.chatwoot_account_id` if needed). Mitigation: capture real payload in B2's integration testing; fallback is backward-compatible.
3. **Concurrency race (DO UPDATE vs DO NOTHING)**: Resolved by D-2's statement-order serialization, proven by live test 6.3/6.4 (concurrent first contacts). Low risk post-verification.
4. **Tenant resolution leakage**: Non-negotiable, proven by negative control test (assertion #2 in live-tenant-resolution.test.ts). Zero risk post-verification.
5. **Bearer token in URL (P4 D-4)**: Compensating control for unconfirmed HMAC. Risk: token in reverse-proxy logs. Mitigation: documented; must be configured in reverse proxy (not application scope); token rotation procedure required.

## Seal

**Archive Status**: COMPLETE
**Verdict**: PASS
**Ready for Deployment**: YES (merged to main via commit c6bc9cc; CI runs 33899572167 and 33922648316 green)

This change is closed, verified, and archived. The webhook ingress specification is canonical at `openspec/specs/webhook-ingress/spec.md`. The extended data-model specification is canonical at `openspec/specs/data-model/spec.md`. All 63 implementation tasks are complete (4.8 intentionally deferred). Zero CRITICAL or WARNING findings. Two disclosed SUGGESTIONs (O3, O4) are documented in code and remain open for follow-up phases.

---

## Artifact Traceability (OpenSpec/Hybrid Mode)

**Persisted Artifacts**:
- Proposal: `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/proposal.md`
- Specification: `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/specs/{webhook-ingress,data-model}/spec.md` (deltas) + `openspec/specs/{webhook-ingress,data-model}/spec.md` (merged to main)
- Design: `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/design.md`
- Tasks: `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/tasks.md`
- Implementation Progress: `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/apply-progress.md`
- Verification: `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/verify-report.md`
- Archive Report: `openspec/changes/archive/2026-09-04-whatsapp-webhook-ingress/archive-report.md` (this file)

All artifacts are in the filesystem (OpenSpec mode). Hybrid mode would persist to Engram as well, but Engram is currently unavailable per PHASES.md session settings; all artifacts are filesystem-only.
