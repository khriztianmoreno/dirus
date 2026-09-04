# Archive Report: extraction-schemas (B1)

**Date**: 2026-09-04
**Executor**: sdd-archive (phase agent)
**Mode**: OpenSpec/Hybrid
**Change**: extraction-schemas (B1 in ROADMAP.md)
**Branch**: main (PR #24 merged)

## Change Summary

**extraction-schemas** delivers Zod validation schemas for the three MVP document classes (`caratula`, `cedula`, `tarjeta_propiedad`) required by B2 (`ingestion-agent`). Implemented as a fast-forward change (proposal/spec/design/tasks/apply/verify trail collapsed into proposal + tasks + apply-progress + spec + verify-report, no separate design.md).

## Verification Status

**Verify Report**: PASS (2026-09-04, commit dd0ff48)
- CRITICAL findings: 0
- WARNING findings: 2 (both disclosed, non-blocking, deferred to B2)
- Test coverage: 42/42 passing (caratula 13, cedula 9, tarjeta-propiedad 17, primitives 3)
- Typecheck: 8/8 packages/apps clean
- Lint: clean
- Dependency rule: 0 workspace-dependency violations (zero `.workspace:*` in `packages/schemas/package.json`)

**Task Completion Gate**: PASS
- All 20 tasks complete (15 original phases + 5 CRITICAL fix batch from verify phase)
- No unchecked implementation tasks

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| extraction-schemas | Created | Merged delta spec from `openspec/changes/extraction-schemas/specs/extraction-schemas/spec.md` → `openspec/specs/extraction-schemas/spec.md`. Spec covers 14 requirements: optional-on-presence, five load-bearing fields, Colombian plate/cédula/owner-doc-number formats, docType closed set, COP currency lock, date shape, premium-amount string shape, normalisation precedence, excluded fields, scope exclusions. All 14 requirements have passing, discriminating, runtime-executed test coverage. |

## Archive Contents

```
openspec/changes/archive/2026-09-04-extraction-schemas/
├── proposal.md                             (intent, scope, affected areas, risks)
├── specs/
│   └── extraction-schemas/
│       └── spec.md                         (14 requirements + scenarios, merged to main specs)
├── tasks.md                                (20 tasks: 15 phases + 5 fix-batch, all complete)
├── apply-progress.md                       (TDD cycle evidence, batch 1 + batch 2)
├── verify-report.md                        (PASS verdict, 3 CRITICAL findings resolved)
└── archive-report.md                       (this file)
```

No design.md present (intentional — fast-forward change, no separate design phase).

**Artifact Status**:
- proposal.md ✓ (complete, clear intent and scope)
- specs/ ✓ (complete, all 14 requirements covered with test scenarios)
- design.md — skipped per fast-forward instructions
- tasks.md ✓ (complete, 20/20 tasks checked)
- apply-progress.md ✓ (complete, TDD cycle evidence + code-line count)
- verify-report.md ✓ (complete, PASS verdict, 0 CRITICAL, 2 disclosed WARNINGs)

## Source of Truth Updated

**Main Specs Location** (canonical, merged):
- `openspec/specs/extraction-schemas/spec.md` — contains full extracted schema specification, ready for B2 consumption

**Implementation** (in live repo branch main, PR #24 merged):
- `packages/schemas/src/primitives.ts` — Colombian-format Zod validators
- `packages/schemas/src/caratula.ts` — caratula (policy cover page) schema
- `packages/schemas/src/cedula.ts` — cedula (national ID) schema
- `packages/schemas/src/tarjeta-propiedad.ts` — tarjeta de propiedad (vehicle registration) schema
- `packages/schemas/src/index.ts` — barrel re-exports
- `packages/schemas/package.json` — zod dependency added
- `packages/schemas/tsconfig.json` — test/** inclusion
- Test files (4): `caratula.test.ts`, `cedula.test.ts`, `tarjeta-propiedad.test.ts`, `primitives.test.ts` (42 tests total)

## Capability Deployed

**extraction-schemas** (B1):
- ✓ Zod schemas for three MVP document classes
- ✓ Zero workspace dependencies (packages/schemas is standalone)
- ✓ Strict TDD: 42/42 tests passing
- ✓ All spec requirements have discriminating test coverage
- ✓ 338 changed lines (batch 1) + 198 changed lines (batch 2 fix) = 536 total, split into two single-PR units under 400-line budget each

## Decision Log

### Fast-Forward Model
This change skipped the separate `spec` and `design` phases per orchestrator instruction. Proposal, tasks, apply-progress, and verify-report stand in for the full SDD trail. The written spec was derived after apply, matching the fast-forward contract.

### Unconfirmed Field Formats (disclosed, deferred to B2)
- Colombian plate regex (`^[A-Z]{3}\d{2}[A-Z0-9]$`): explicitly flagged as needing golden-dataset confirmation
- Cédula/owner-doc-number digit ranges: explicitly flagged as needing golden-dataset confirmation
- Both are documented in spec's "Field formats chosen without repo precedent" requirement
- Both have passing test coverage against the chosen patterns
- B2 is the validation gate; B1 has done its job (consistent, tested shapes)

### Open Decision: `.strict()` Deferred to B2
The three schemas intentionally do NOT call `.strict()` (which would reject unknown keys). This is a decision, not an oversight. Recorded as an explicit "Open Decision" in the spec under the "Fields With No Destination Column Are Excluded" requirement. B2 owns the tradeoff and should implement key-set diff + `needs_review` routing.

### CRITICAL Findings Resolved
- **Finding 1 (ownerDocNumber defect)**: Fixed by implementing per-`ownerDocType` validation via `superRefine` + `OWNER_DOC_NUMBER_PATTERNS` (5 patterns: CC, TI, CE, NIT, PA). Coherent with cedula.ts (same CC pattern). Test-verified with discriminating tests.
- **Finding 2 (plate normalisation gap)**: Closed by adding `primitives.test.ts` with 3 tests asserting both success and normalised value.
- **Finding 3 (unknown-key stripping gap)**: Closed by adding stripping tests to all three schema files, asserting both success and exact known-key subset.

## Dependencies and Impact

**Unblocks**: B2 (`ingestion-agent`) — B2 was explicitly blocked on this capability and can now proceed (subject to B2's own blocker: golden dataset collection).

**Deferred to B2**:
- Confidence thresholds (0.85)
- needs_review re-ask flow
- Flash → Pro escalation logic
- Key-set diff and needs_review routing (for the `.strict()` open decision)
- Model integration and multimodal extraction

**No impact on**: A1/A2 (renewal track runs independently; these schemas are only for extraction ingestion).

## Tracking Updates

**PHASES.md**: Updated to show B1 (extraction-schemas) complete, all phases archived.

**ROADMAP.md**: Updated to show B1 status: "DONE (archived 2026-09-04)", 0 CRITICAL findings, 2 disclosed WARNINGs (non-blocking).

**Main Specs**: `openspec/specs/extraction-schemas/spec.md` created and populated.

**Archive Location**: `openspec/changes/archive/2026-09-04-extraction-schemas/` contains all phase artifacts.

## Merge Completeness Check

- Delta spec merged into main specs: YES (new domain, no conflict)
- Change folder moved to archive: YES (created at dated archive location)
- Unchecked tasks remaining: NO (all 20 checked)
- CRITICAL issues in verify-report: NO (0 CRITICAL, 2 disclosed WARNINGs)
- Artifacts missing (that were supposed to exist): NO (fast-forward model explicitly skips design.md)

## Ready for Next Phase

B2 (`ingestion-agent`) is now dependency-ready (this change is complete). B2 is NOT startable until the golden dataset blocker is resolved (see ROADMAP.md).

## Risks Noted

1. **Plate/cédula regex strictness**: Acknowledged in proposal as "Medium" likelihood. Mitigation: B2 (golden dataset) is the validation gate. If formats are too strict, they will be disproven by real documents.
2. **Zod major version drift**: Pinned to `^4.4.3`; patches only. Low risk.
3. **Non-ISO date shape upstream**: Spec documents this as an assumption (normalization happens before schema validation). If violated, will manifest as validation failures in B2; by design.

## Seal

**Archive Status**: COMPLETE
**Verdict**: PASS
**Ready for Deployment**: YES (merged to main via PR #24)

This change is closed, verified, and archived. The extracted specification is canonical at `openspec/specs/extraction-schemas/spec.md`. All 20 implementation tasks are complete. Zero CRITICAL findings. Ready for B2.

---

## Artifact Traceability (OpenSpec/Hybrid Mode)

**Persisted Artifacts**:
- Proposal: `openspec/changes/archive/2026-09-04-extraction-schemas/proposal.md`
- Specification: `openspec/changes/archive/2026-09-04-extraction-schemas/specs/extraction-schemas/spec.md` (delta) + `openspec/specs/extraction-schemas/spec.md` (merged to main)
- Tasks: `openspec/changes/archive/2026-09-04-extraction-schemas/tasks.md`
- Design: Not applicable (fast-forward change)
- Implementation Progress: `openspec/changes/archive/2026-09-04-extraction-schemas/apply-progress.md`
- Verification: `openspec/changes/archive/2026-09-04-extraction-schemas/verify-report.md`
- Archive Report: `openspec/changes/archive/2026-09-04-extraction-schemas/archive-report.md` (this file)

All artifacts are in filesystem (OpenSpec mode) and available for review/audit. No Engram persistence attempted (Engram reported unavailable in PHASES.md session settings, all artifacts filesystem-only).
