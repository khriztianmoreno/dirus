# Archive Report: admin-dashboard (C1)

**Date**: 2026-09-07
**Change**: `admin-dashboard` (C1 — Convergence: login + extraction review + §12 metrics)
**Archiver**: sdd-archive
**Mode**: OpenSpec (hybrid with Engram persistence)

## Executive Summary

Change `admin-dashboard` (C1) has been fully implemented (8 phases, 101 tasks), verified green (commit 1afa8be, CI run 34135779237), and archived. All delta specs have been merged into the main specification suite. The change introduces the first human-authentication mechanism in DIRUS (email magic-link), the first frontend SPA (`apps/dashboard`), and the complete product metrics layer from §12 of the architecture. No CRITICAL findings. Ready for the next change.

## Change Closure

- **Change**: `admin-dashboard`
- **Type**: Full SDD cycle (not fast-forward)
- **Status**: DONE — All phases implemented, verified PASS, archived
- **Archived to**: `openspec/changes/archive/2026-09-07-admin-dashboard/`
- **Verification Verdict**: PASS (0 CRITICAL, 2 disclosed non-blocking WARNINGs)
- **Verified Commit**: `1afa8be` on branch `feat/admin-dashboard`
- **CI Run**: 34135779237 (all checks green)

## Scope Summary

### New Capabilities Added

1. **broker-auth** (8 requirements):
   - Email magic-link issuance, single-use token consumption, session lifecycle, server-side tenant resolution, logout
   - Anti-enumeration response (byte-identical for known/unknown emails)
   - Session via httpOnly signed cookie with 7-day sliding idle expiry
   - CSRF protection via constant-time token comparison

2. **extraction-review** (5 requirements):
   - Review queue endpoint listing `extractions WHERE needs_review = true`
   - Per-field envelope rendering with per-field confidence scores
   - Reviewer correction workflow (correctedOutput, correctedBy from session, NOT client input)
   - Automatic flag clearance on successful correction
   - 0.85 confidence threshold and re-ask-never-guess rule preserved

3. **product-metrics** (6 requirements):
   - Six live-query metric endpoints (copilot usage, renewal funnel, extraction review load, conversation resolution snapshot, time-to-first-renewal, cost/deferred)
   - Each metric backed by real queries, not hardcoded values
   - Explicit empty-state results distinguishable from zero
   - Current-state snapshot label on conversation-resolution panel (not §12 at-close)
   - Cost metric explicitly discloses deferred state (Langfuse not yet integrated)
   - All metrics scoped to authenticated broker session, never client-supplied `brokerId`

4. **dashboard-app** (implicit):
   - Vite + React SPA at `apps/dashboard/`
   - Build to static bundle at `dist/`
   - Auth shell with `RequireSession` guard
   - Review queue screen, metrics dashboard
   - Reverse-proxy integration via Caddy (infra/Caddyfile updated)

### Modified Capabilities

1. **data-model** (3 new requirements added to existing spec):
   - `broker_users.email` — nullable, globally unique login credential
   - `magic_link_tokens` table — hashed tokens, single-use, expiring, RLS-scoped
   - `magic_link_tokens` RLS policy matching all other `broker_id` tables

## Specifications Merged into Main Suite

### New Specifications Created in `openspec/specs/`

| Spec | Requirements | Source |
|------|--------------|--------|
| `broker-auth/spec.md` | 8 | Delta from `changes/admin-dashboard/specs/broker-auth/spec.md` |
| `extraction-review/spec.md` | 5 | Delta from `changes/admin-dashboard/specs/extraction-review/spec.md` |
| `product-metrics/spec.md` | 6 | Delta from `changes/admin-dashboard/specs/product-metrics/spec.md` |

### Modified Specifications in `openspec/specs/`

| Spec | Prior | Added | Total | Notes |
|------|-------|-------|-------|-------|
| `data-model/spec.md` | 15 reqs (F1+F2+A1) | 3 reqs (C1) | 18 reqs | Delta section added: "Email Login Credentials and Magic-Link Tokens (C1 Extension)" |

**Total Requirements Added**: 22 (8 broker-auth + 5 extraction-review + 6 product-metrics + 3 data-model delta)

## Task Completion

- **Total Tasks**: 84 across 8 phases
- **Status**: All 101 tasks [x] checked
- **Phases**:
  - Phase 1 (Migration + live proof): 10 tasks — PASS (live gate D-A confirmed in CI)
  - Phase 2 (DB exports): 7 tasks — PASS
  - Phase 3 (Email + auth endpoints): 19 tasks — PASS (anti-enumeration oracle verified)
  - Phase 4 (Session/CSRF middleware): 15 tasks — PASS (no deadlock detected)
  - Phase 5 (Review queue): 15 tasks — PASS
  - Phase 6 (Metrics): 17 tasks — PASS (live deltas confirmed)
  - Phase 7 (SPA + Caddy): 11 tasks — PASS
  - Phase 8 (Cross-tenant isolation): 8 tasks — PASS (live end-to-end proven)

## Verification Summary

**Verdict**: PASS

**No CRITICAL Issues**

**2 Disclosed Non-Blocking Warnings**:
1. Frontend unit-test gap: `apps/dashboard` has zero component/route test coverage. Phase 7's scope was SPA shell + reverse-proxy wiring. CSRF/session-cookie logic verified from API side; frontend's own `apiRequest`/`RequireSession`/route components have no direct tests. Not a spec violation (no spec mandates frontend unit tests) but flagged for awareness before archive.

2. Live test suite signal from CI only: Sessions, magic-link consumption, cross-tenant isolation, metrics, review-queue, webhook-ingress, and policies-import live suites all correctly SKIP locally (no Postgres reachable in apply environment). Their green signal comes entirely from CI run 34135779237, not local execution. Expected and matches project convention; noted for transparency.

**Non-Negotiables Verified**:
1. ✅ No dashboard/auth route Zod schema accepts client-supplied `brokerId`
2. ✅ RLS is `FORCE ROW LEVEL SECURITY` with matching `USING`/`WITH CHECK`
3. ✅ Three `SECURITY DEFINER` resolver functions owned by `dirus_tenant_resolver` with pinned `search_path`
4. ✅ CSRF uses `crypto.timingSafeEqual`, not `===`
5. ✅ Session cookie attributes match design (HttpOnly, Secure, SameSite=Lax, Max-Age=604800)
6. ✅ Anti-enumeration: byte-identical 202 regardless of email existence
7. ✅ `admin-auth.ts` and `ADMIN_API_TOKEN` untouched since A1
8. ✅ Cross-tenant isolation live test is genuinely discriminating (positive + negative controls, real set-emptiness check)

## Success Criteria (from proposal)

- [x] A `broker_users` row with an email can request a link, receive it, click it, and land authenticated in the dashboard
- [x] A magic-link token cannot be used twice; a second use is rejected
- [x] An expired token is rejected
- [x] `magic_link_tokens` never contains a raw token — asserted against actual stored column
- [x] Requesting a link for an unknown email returns **identical** response to known one
- [x] **Non-negotiable**: live test proves authenticated broker A cannot read broker B's extractions, renewals, or metrics (with positive control)
- [x] **Non-negotiable**: no dashboard endpoint accepts `brokerId` from client (inspection of every route schema)
- [x] Review queue lists `extractions WHERE needs_review`, shows per-field values/confidences, persists corrections
- [x] All 6 §12 metrics have endpoints; five return correct values against seeded fixtures and correct empty-state; cost metric disclosed as deferred
- [x] "Resolved without human" panel labelled current-state snapshot in UI, not §12 at-close metric
- [x] `apps/dashboard` builds to `dist/` and runs against `apps/api` end-to-end
- [x] `pnpm -r typecheck`, `pnpm -r test`, `pnpm run lint`, `pnpm run lint:deps` all pass with new app in workspace
- [x] `ROADMAP.md` C1 no longer claims `(ff)`

## Source of Truth Updated

The following specifications now reflect the full implemented behavior, ready for next changes:

- `openspec/specs/broker-auth/spec.md` — 8 requirements on magic-link auth, session lifecycle, tenant resolution
- `openspec/specs/extraction-review/spec.md` — 5 requirements on review queue, correction workflow
- `openspec/specs/product-metrics/spec.md` — 6 requirements on metric endpoints, empty-state semantics
- `openspec/specs/data-model/spec.md` — extended with 3 new requirements (email column, magic_link_tokens table, RLS)

## Archive Contents

This folder contains:
- `proposal.md` — Full product and technical approach for C1
- `design.md` — Architecture decisions D-A through D-H
- `specs/` — Delta specifications (broker-auth, extraction-review, product-metrics, data-model)
- `tasks.md` — 101 tasks across 8 phases, all checked
- `apply-progress.md` — Phase implementation record
- `verify-report.md` — Non-negotiable verification and spec compliance matrix
- `archive-report.md` — This file, closure record

## Roadmap Impact

- `openspec/ROADMAP.md` updated: C1 now shows "**DONE** (archived 2026-09-07)"
- `openspec/PHASES.md` updated: C1's verify and archive phases marked done
- Status transitions: `admin-dashboard` is closed; pipeline ready for next change

## Next Steps

The change is fully archived. No follow-up work is required from this phase. Next phases:
- **A2 (`renewal-agent`)**: blocked on Meta HSM template approval
- **B2 (`ingestion-agent`)**: blocked on golden dataset collection
- **All other changes**: see `ROADMAP.md` dependency graph

The metrics layer built in C1 returns correct-and-empty results now and will return real numbers the day A2 or B2 lands, with no code change to C1 itself.

---

**Archived by**: sdd-archive (executor phase)
**Date**: 2026-09-07
**Traceability**: All artifacts verified and merged. Change is complete.
