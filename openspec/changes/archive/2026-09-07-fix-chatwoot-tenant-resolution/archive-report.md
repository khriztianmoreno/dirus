# Archive Report: fix-chatwoot-tenant-resolution (F2.1)

**Change**: `fix-chatwoot-tenant-resolution`  
**Archived to**: `openspec/changes/archive/2026-09-07-fix-chatwoot-tenant-resolution/`  
**Archived on**: 2026-09-07  
**Verdict**: PASS — all delta specs successfully merged into main specs; change is closed

---

## Executive Summary

F2.1 successfully corrects two always-fatal defects in the archived F2 (`whatsapp-webhook-ingress`) capability by replacing the non-existent payload-based tenant resolution key (`inbox.phone_number` → `brokers.wa_phone_number_id`) with an integer-typed key (`account.id` → `brokers.chatwoot_account_id`). All 41 tasks verified complete across 5 phases; migration `0007` proven on a real non-superuser Neon connection; live end-to-end confirmation against the running self-hosted Chatwoot instance validates that real webhooks now resolve correctly. Delta specs **supersede** (not append to) the defective requirements previously merged from F2 — a critical distinction stated in proposal P4 and enforced at archive time. The composite specs now reflect only the corrected, integer-keyed resolution mechanism; no `wa_phone_number_id`-based resolution requirement remains visible anywhere in `openspec/specs/`.

---

## Spec Merge: Reconciliation and Verification

### webhook-ingress/spec.md

**Supersession**: Requirement "Tenant Resolution by wa_phone_number_id" (originally at lines 41-69 of the pre-merge main spec) has been **replaced** by "Tenant Resolution by account.id" with identical requirement-level scope but updated observable behavior.

**Before merge**:  
- 9 requirements (8 base + 1 resolved-key requirement)
- 18 scenarios (15 base + 3 for the resolution key)

**After merge**:  
- 9 requirements (8 base + 1 resolved-key requirement) — no net change in count; one requirement replaced in-place
- 21 scenarios (15 base + 6 for the resolution key) — the merged requirement added 3 new scenarios:
  - "extractResolutionKey returns a number for a well-formed payload"
  - "extractResolutionKey returns null, never throws, when account.id is absent or malformed"
  - "A non-integer, negative, or out-of-int4-range account.id is refused before any query runs"

**Verification**: The requirement name changed; old text referring to `wa_phone_number_id` / `inbox.phone_number` / text-keyed lookup removed entirely; new text establishes integer-keyed resolution on `account.id` → `chatwoot_account_id` and specifies boundary validation (integer-range guard before any query). No residual references to the old key remain in the webhook-ingress spec.

### data-model/spec.md

**Supersession**: Four requirements from the F2 extension ("Tenant Resolver Role") have been **replaced** in-place with updated text reflecting the new integer signature and `chatwoot_account_id` column:

1. "The Permissive brokers Lookup Policy Is Scoped to the Resolver Role Only" — scenarios updated to reference `0007` and integer-keyed calls (e.g., `dirus_resolve_broker_id(555001)` instead of `dirus_resolve_broker_id('phoneA')`); no new scenarios added
2. "The Resolver Function Is SECURITY DEFINER..." — **title extended** to explicitly name "Takes an Integer Key"; (a) old text-keyed `(p_key text)` removed; (b) new requirement that function must `DROP` the old `(text)` signature; (c) 6 scenarios total (was 5) — new scenario "The old text-keyed function no longer exists after 0007" added
3. "dirus_app May EXECUTE the Resolver Function..." — requirement text and scenarios updated to reference `(integer)` signature instead of `(text)`; example calls changed from `dirus_resolve_broker_id('phoneA')` to `dirus_resolve_broker_id(555001)`; no change in scenario count (3)
4. "Tenant Resolution Does Not Filter on brokers.status" — scenarios updated to reference `chatwoot_account_id = 777` instead of `wa_phone_number_id = 'phoneS'`; no change in scenario count (2)

**Addition**: One entirely new requirement has been **appended**:

5. "The Resolver Role's Column-Scoped Grant Is Limited to id and chatwoot_account_id" — mandatory per proposal P3: this migration moves the column-scoped grant from `(id, wa_phone_number_id)` to `(id, chatwoot_account_id)` in the same migration that creates the integer-signature function, preventing a grant-miss failure mode where a function can read the row but not the column it filters on. Three scenarios: (a) grant is exactly `(id, chatwoot_account_id)`; (b) `wa_phone_number_id` is no longer reachable; (c) grant and function ship together in `0007`.

**Before merge**:  
- 18 requirements (8 base + 6 F2 extension + 1 A1 extension + 3 C1 extension)
- 41 scenarios (8 + 15 + 4 + 3 + 2 + 2 + 4 + 3 + 1 + 2 = 41)

**After merge** (counted directly against `openspec/specs/data-model/spec.md`, not re-derived from the pre-merge arithmetic above — that arithmetic undercounted by 3):  
- 19 requirements (8 base + 7 F2 extension [6 original + 1 new] + 1 A1 extension + 3 C1 extension)
- **48 scenarios** (`rg -c "^#### Scenario:" openspec/specs/data-model/spec.md` → 48)

**Verification**: All four modified requirements correctly reference `0007` and `chatwoot_account_id` instead of `0004` and `wa_phone_number_id`. The new requirement properly states the grant-before-revoke ordering from design P3. Spot-check confirms no `wa_phone_number_id`-keyed scenario remains in any of the four replaced requirements; all example calls use integer account IDs.

---

## No Stale wa_phone_number_id Resolution Requirement Remains

A critical requirement of this archive (proposal P4 and verification checklist item): the old, defective resolution requirements have been completely removed, not left alongside the new ones.

**Confirmation**:
- `openspec/specs/webhook-ingress/spec.md`: searched for `wa_phone_number_id` in requirements section — found only in the "Previously:" migration note under "Tenant Resolution by account.id", which explicitly documents the old, broken behavior for posterity; no standalone "Tenant Resolution by wa_phone_number_id" requirement exists
- `openspec/specs/data-model/spec.md`: searched for `wa_phone_number_id` in the F2 extension requirements — found only in:
  - The "Previously:" note under "The Resolver Function..." (documenting old `(p_key text)` signature)
  - The "Previously:" note under "Tenant Resolution Does Not Filter" (documenting old column name)
  - Two scenario names under the new "Column-Scoped Grant" requirement: "wa_phone_number_id is no longer reachable" (proving it's been revoked) and the scenario body (asserting the grant was removed)
  - No lingering requirement named "Tenant Resolver Role" filtering on `wa_phone_number_id` exists

**Conclusion**: The supersession is complete. Readers of `openspec/specs/` see only the corrected, `account.id`-based resolution path.

**Orchestrator follow-up correction (post-merge, before commit)**: the merge above correctly replaced the *requirement blocks* this change's delta named, but left four unrelated in-body phrases stale — scenario prose in `webhook-ingress/spec.md`'s "Inbound Webhook Authentication" and "Media Message Persistence" requirements ("a known `wa_phone_number_id`" → "a known `account.id`"), a scenario assertion in "Multi-Tenant Isolation" ("the mechanism that resolves `wa_phone_number_id → broker_id`" → "`account.id → broker_id`"), and `data-model/spec.md`'s "Idempotency Constraints" requirement, whose parenthetical purpose note for `brokers.wa_phone_number_id` still read "(tenant resolution per webhook)" after it stopped being that. None of these were part of this change's own MODIFIED requirement list (they belong to requirements this delta never touched), which is why the agent's search — scoped to the requirements this change modified — did not catch them. Corrected directly in `openspec/specs/{webhook-ingress,data-model}/spec.md` before this archive was committed; re-verified with `rg wa_phone_number_id` across both composite files afterward — every remaining occurrence is a "Previously:" note or a negative-constraint scenario ("no longer reachable"/"MUST NOT leave reachable"), none asserts it as current behavior.

---

## Task Completion

**Total tasks**: 41 (across 5 phases)  
**Completion rate**: 100% — all tasks marked `[x]` in `tasks.md`

**Phase breakdown**:
- **Phase 1**: Migration `0007` + non-superuser drop proof on real Neon. Task 1.5 (hard gate) confirmed empirically. Two additional defects discovered and fixed during live proof (missing `meta/_journal.json` entry; silent `REVOKE ALL ... FROM PUBLIC` no-op on `0006` functions). All 7 tasks complete.
- **Phase 2**: Real captured Chatwoot payload replacing the docs-derived fixture; schema narrowing (`inbox` → `{id, name?}`; drop `contact` field); `extractResolutionKey()` integer-range guard. Fixture closes F2's deferred task 4.8 and resolves O4. All 9 tasks complete.
- **Phase 3**: TypeScript surface (`resolveBrokerIdByChatwootAccountId`, integer parameter, guard replaces `MAX_KEY_LENGTH`); barrel export update; docstring updates. All 7 tasks complete.
- **Phase 4**: Middleware and route updates; ingest-message service correction (`sender.phone_number` not `contact.phone_number`); wiring. All 10 tasks complete.
- **Phase 5**: Live end-to-end proof against the running Chatwoot instance; real webhook POST resolves correct broker and persists one `messages` row; unknown `account.id` refused with clean 404 and sanitized log; ROADMAP/PHASES updates. All 8 tasks complete.

**Evidence**: `pnpm -r typecheck` clean; `pnpm -r test` 391 passed offline (with expected skips for live suites); CI green on `main`; live Postgres tests pass; real webhook delivery from Chatwoot instance successful.

---

## Verification Report Artifact

**Observation ID** (Engram): [verify-report recorded during verify phase]  
**Verdict**: PASS — 0 CRITICAL, 1 WARNING (W1: `0006`-function `PUBLIC EXECUTE` fix in `0007`'s step 5b untested live by this repo's automated suite; verified once manually; see verify-report for full context)

The one WARNING is informational and does not block archive. The fix itself is sound and was independently proven via direct `has_function_privilege()` query against the developer's real database.

---

## Archive Contents

- `proposal.md` ✅ — Full scope, approach, 4 product decisions (P1-P4), success criteria, risks, dependencies, rollback plan. P4 explicitly settles the supersession policy.
- `specs/webhook-ingress/spec.md` ✅ — Delta; merged into `openspec/specs/webhook-ingress/spec.md`
- `specs/data-model/spec.md` ✅ — Delta; merged into `openspec/specs/data-model/spec.md`
- `design.md` ✅ — Full D-A through D-G design decisions (schema narrowing, extraction key signature, boundary guard, migration strategy, test control table, TS surface, route/middleware changes)
- `tasks.md` ✅ — 5 phases, 41 tasks, all complete. Includes full Phase 1 hard-gate narrative with empirical proof and defect discovery record.
- `apply-progress.md` ✅ — Per-phase progress notes; includes the live defect fixes (journal entry, `0006` REVOKE correction).
- `verify-report.md` ✅ — PASS verdict with all 11 success criteria verified requirement-by-requirement; C1 historical note (pre-existing `0004`/`0006` edit) resolved via addendum; W1 warning noted but non-blocking.

---

## Source of Truth Updated

The following main specs now reflect the corrected behavior and are the source of truth going forward:

- `openspec/specs/webhook-ingress/spec.md` — 9 requirements, 21 scenarios (corrected resolution key)
- `openspec/specs/data-model/spec.md` — 19 requirements, 45 scenarios (corrected F2 extension + new column-grant requirement)

Any reference to `wa_phone_number_id` as a webhook-ingress resolution key outside of the "Previously:" migration notes is now a defect. A2 and B2, which both build on ingress, have an up-to-date, working foundation.

---

## SDD Cycle Complete

This change has been fully proposed, specified, designed, tasked, applied (with live proof), verified (PASS), and archived. The corrected tenant-resolution mechanism is closed and ready for downstream consumption.

**Next**: Unblock A2 (`renewal-agent`, pending HSM template approval) and B2 (`ingestion-agent`, pending golden dataset), which both depend on an ingress path that can actually receive real Chatwoot webhooks. F2.1 delivers that proof.

---

## Traceability

| Artifact | Location |
|----------|----------|
| Proposal (P1-P4 decisions, O4 closeout) | `openspec/changes/archive/2026-09-07-fix-chatwoot-tenant-resolution/proposal.md` |
| Spec delta (webhook-ingress) | `openspec/changes/archive/2026-09-07-fix-chatwoot-tenant-resolution/specs/webhook-ingress/spec.md` |
| Spec delta (data-model) | `openspec/changes/archive/2026-09-07-fix-chatwoot-tenant-resolution/specs/data-model/spec.md` |
| Design (D-A through D-G) | `openspec/changes/archive/2026-09-07-fix-chatwoot-tenant-resolution/design.md` |
| Tasks (41 total, 5 phases) | `openspec/changes/archive/2026-09-07-fix-chatwoot-tenant-resolution/tasks.md` |
| Apply progress (phase outcomes) | `openspec/changes/archive/2026-09-07-fix-chatwoot-tenant-resolution/apply-progress.md` |
| Verification (PASS) | `openspec/changes/archive/2026-09-07-fix-chatwoot-tenant-resolution/verify-report.md` |
| Main spec (webhook-ingress) merged | `openspec/specs/webhook-ingress/spec.md` |
| Main spec (data-model) merged | `openspec/specs/data-model/spec.md` |
| Roadmap updated | `openspec/ROADMAP.md` (F2.1 marked ARCHIVED) |
| Phases updated | `openspec/PHASES.md` (F2.1 verify and archive marked done) |
