# Apply Progress: Extraction schemas (caratula, cedula, tarjeta_propiedad)

**Change**: extraction-schemas (B1)
**Mode**: Strict TDD
**Branch**: `feat/extraction-schemas` (off `main`)

## TDD Cycle Evidence

| Task | RED (written first) | GREEN | REFACTOR |
|---|---|---|---|
| `caratulaSchema` | `test/caratula.test.ts` written and run first — failed with "Failed to load url ../src/caratula.js" (module did not exist) | `src/caratula.ts` implemented; 10/10 tests pass | Extracted shared primitives into `primitives.ts` instead of inlining regexes per schema |
| `cedulaSchema` | `test/cedula.test.ts` written and run first — failed alongside caratula/tarjeta (same RED batch, module not found) | `src/cedula.ts` implemented; 7/7 tests pass | None needed |
| `tarjetaPropiedadSchema` | `test/tarjeta-propiedad.test.ts` written and run first — failed (module not found) | `src/tarjeta-propiedad.ts` implemented; 8/8 tests pass | None needed |

All three test files were written and executed together before any `src/*.ts`
implementation existed (single RED batch), then all three implementation
files were written together and re-run (single GREEN batch). This is a
batched RED→GREEN cycle across the three schemas rather than a strict
per-file cycle; no implementation code was written before its test existed.

## Completed Tasks

- [x] 1.1 `zod` added to `packages/schemas/package.json` as a plain dependency (`^4.4.3`, not `workspace:*`)
- [x] 1.2 `packages/schemas/src/primitives.ts` — Colombian plate, cédula number, doc type enum, ISO date (real-calendar-date refine), COP currency literal, COP amount decimal string, insurer line enum, insurer name, full name
- [x] 2.1 `packages/schemas/test/caratula.test.ts`
- [x] 2.2 `packages/schemas/src/caratula.ts`
- [x] 2.3 `packages/schemas/test/cedula.test.ts`
- [x] 2.4 `packages/schemas/src/cedula.ts`
- [x] 2.5 `packages/schemas/test/tarjeta-propiedad.test.ts`
- [x] 2.6 `packages/schemas/src/tarjeta-propiedad.ts`
- [x] 3.1 `packages/schemas/src/index.ts` barrel updated
- [x] 3.2 `packages/schemas/tsconfig.json` includes `test/**/*.ts`
- [x] 4.1–4.5 Verification (see below)

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `packages/schemas/package.json` | Modified | Added `zod: ^4.4.3` dependency |
| `packages/schemas/src/primitives.ts` | Created | Shared Colombian-format Zod primitives |
| `packages/schemas/src/caratula.ts` | Created | `caratulaSchema` + `Caratula` type |
| `packages/schemas/src/cedula.ts` | Created | `cedulaSchema` + `Cedula` type |
| `packages/schemas/src/tarjeta-propiedad.ts` | Created | `tarjetaPropiedadSchema` + `TarjetaPropiedad` type |
| `packages/schemas/src/index.ts` | Modified | Barrel re-exports the four new modules |
| `packages/schemas/tsconfig.json` | Modified | `include` now covers `test/**/*.ts` |
| `packages/schemas/test/caratula.test.ts` | Created | 10 tests |
| `packages/schemas/test/cedula.test.ts` | Created | 7 tests |
| `packages/schemas/test/tarjeta-propiedad.test.ts` | Created | 8 tests |

## Verification (actual output)

- `pnpm --filter @dirus/schemas exec vitest run`: **3 test files passed (3), 25 tests passed (25)**
- `pnpm -r run typecheck`: all 8 workspace projects report `Done`, zero errors
- `pnpm run lint`: clean, zero output beyond the script header
- `pnpm run lint:deps`: `no dependency violations found (76 modules, 157 dependencies cruised)`
- `pnpm --filter @dirus/config exec vitest run`: **4/4 passed** — confirms `packages/schemas/package.json` still declares zero `workspace:*` dependencies
- Full suite (`pnpm -r run test`) against an ephemeral `pgvector/pgvector:pg17` container (random host port, unique container name, `dirus_test` + `dirus_migrate_test` created, `LIVE_TEST_DATABASE_URL` / `MIGRATE_RUNNER_TEST_DATABASE_URL_UNPOOLED` set, container removed after): **122 tests passed, 0 skipped, 0 failed** — `packages/db` 93 (unchanged baseline) + `packages/config` 4 + `packages/schemas` 25 (new)

## Code-only changed-line count

`git diff --cached --stat -- packages/schemas` (excluding `pnpm-lock.yaml`):
**338 changed lines** (333 additions, 5 deletions) across 10 files. Within
the 400-line review budget; no chained/stacked PR needed.

## Deviations from Design

None — no design.md exists for this fast-forward change; implementation
follows `proposal.md` and `docs/ARCHITECTURE.md` directly.

## Field formats chosen without repo backing (flagged for golden-dataset confirmation)

See `proposal.md` § "Field formats chosen without repo precedent" — plate
regex, cédula number digit range, `docType` closed set, COP-only currency,
`YYYY-MM-DD` date shape, and decimal-string premium amount all have no
prior repo precedent and are the most likely candidates to be disproven by
real documents once B2's golden dataset lands.

## Issues Found

None.

## Remaining Tasks

None — all tasks complete.

## Workload / PR Boundary

- Mode: single PR
- Current work unit: extraction-schemas (B1), entire change
- Boundary: `packages/schemas/**` only; no other package touched
- Estimated review budget impact: 338 changed lines, well under the 400-line budget

## Status (batch 1)

15/15 tasks complete. Ready for verify.

---

## Batch 2 — Fix CRITICAL findings from `sdd-verify` (routed back)

**Source**: `openspec/changes/extraction-schemas/verify-report.md` — verdict FAIL, 3 CRITICAL findings.

### TDD Cycle Evidence (batch 2)

| Task | RED (proven first) | GREEN | REFACTOR |
|---|---|---|---|
| 5.1 `ownerDocNumber` per-`ownerDocType` validation | Added 3 tests to `tarjeta-propiedad.test.ts` (valid `PA` alphanumeric, valid `NIT` with verification digit, valid `CE` 12-digit) against the unmodified (buggy) `tarjeta-propiedad.ts`. Ran `vitest run test/tarjeta-propiedad.test.ts`: **3 failed, 13 passed (16)** — all 3 new tests failed exactly as predicted (old code rejected valid PA/NIT/CE numbers) | Rewrote `tarjetaPropiedadSchema` with `.superRefine` + `OWNER_DOC_NUMBER_PATTERNS` keyed by `ownerDocType`. Re-ran: **16/16 passed** | None needed — single conditional-validation pass, no further extraction |
| 5.2 Plate normalisation test coverage | Wrote `primitives.test.ts` (3 tests: lowercase, whitespace-padded, mixed-case). Temporarily removed `.trim().toUpperCase()` from `colombianPlateSchema` in `primitives.ts`, ran `vitest run test/primitives.test.ts`: **3 failed** | Restored `.trim().toUpperCase()`, re-ran: **3/3 passed** | None — production code was already correct, this closes a test gap only |
| 5.3 Unknown-key stripping test coverage (all 3 schemas) | Added 1 stripping test per schema file. Temporarily added `.strict()` to `caratulaSchema`, `cedulaSchema`, `tarjetaPropiedadSchema`. Ran full `vitest run`: **6 failed** (3 stripping tests + 3 min-length tests below, run together in the same mutation pass), 36 passed | Reverted all `.strict()` mutations, re-ran: **42/42 passed** | `.strict()` intentionally NOT kept — see spec's "Open Decision" section; deferred to B2 |
| 5.4 Malformed `insurer`/`fullName` test coverage (WARNING) | Added 1-char `insurer` test to `caratula.test.ts`, 1-char `insuredFullName` test to `caratula.test.ts`, 1-char `fullName` test to `cedula.test.ts`. Temporarily removed `.min(2, ...)` from `insurerNameSchema` and `fullNameSchema` in `primitives.ts` (same mutation pass as 5.3 above — combined RED run: 6 failed) | Restored `.min(2, ...)` on both (same revert as 5.3), re-ran: **42/42 passed** | None — production code was already correct |

### Completed Tasks (batch 2)

- [x] 5.1 `packages/schemas/src/tarjeta-propiedad.ts` — per-`ownerDocType` `ownerDocNumber` validation
- [x] 5.2 `packages/schemas/test/primitives.test.ts` — plate normalisation coverage (new file)
- [x] 5.3 Unknown-key stripping tests in `caratula.test.ts`, `cedula.test.ts`, `tarjeta-propiedad.test.ts`
- [x] 5.4 Malformed `insurer`/`fullName` tests in `caratula.test.ts`, `cedula.test.ts`
- [x] 5.5 Full verification re-run (see below)

### Files Changed (batch 2)

| File | Action | What Was Done |
|------|--------|---------------|
| `packages/schemas/src/tarjeta-propiedad.ts` | Modified | `ownerDocNumber` now validated per `ownerDocType` via `superRefine` + `OWNER_DOC_NUMBER_PATTERNS` (CC/TI/CE digit patterns, NIT with optional verification digit, PA alphanumeric); default to CC pattern when `ownerDocType` absent |
| `packages/schemas/test/tarjeta-propiedad.test.ts` | Modified | +9 tests: valid PA/NIT/CE/TI owner numbers accepted, malformed PA/NIT rejected, CC-with-punctuation still rejected, docType-absent default, unknown-key stripping |
| `packages/schemas/test/primitives.test.ts` | Created | 3 tests proving plate normalisation (`.trim().toUpperCase()`) precedes regex validation |
| `packages/schemas/test/caratula.test.ts` | Modified | +3 tests: malformed `insurer`, malformed `insuredFullName`, unknown-key stripping |
| `packages/schemas/test/cedula.test.ts` | Modified | +2 tests: malformed `fullName`, unknown-key stripping |

**Code-only changed-line count (batch 2)**: `git diff --stat -- packages/schemas` on tracked files = 163 insertions + 7 deletions (170 lines) across 4 modified files, plus 1 new file (`primitives.test.ts`, 28 lines, all additions) = **198 changed lines total**. Well under the 400-line review budget; no chained/stacked PR needed.

### Verification (batch 2, actual output)

- `pnpm --filter @dirus/schemas exec vitest run`: **4 test files passed (4), 42 tests passed (42)** (up from 3 files / 25 tests)
- `pnpm -r run typecheck`: all 8 workspace projects report `Done`, zero errors
- `pnpm run lint`: clean, zero output beyond the script header
- `pnpm run lint:deps`: `no dependency violations found (77 modules, 159 dependencies cruised)`

### Deviations from Design (batch 2)

None — no `design.md` exists for this fast-forward change. Implementation follows `verify-report.md`'s CRITICAL findings directly, and the spec was updated to match (see `specs/extraction-schemas/spec.md`).

### Explicitly Deferred (not a gap): `.strict()` on the three schemas

Per the fix instructions and the verify report's own framing, `.strict()`
was deliberately NOT added. Recorded as an open decision in
`specs/extraction-schemas/spec.md` (see "Open Decision" under the
"Fields With No Destination Column Are Excluded" requirement) and here:
an LLM producer's output keys are not stable, so neither "silently strip
unknown keys" (current, non-strict) nor "reject on any unknown key"
(`.strict()`) is correct at the schema-validation layer. The correct owner
of this tradeoff is B2 (`ingestion-agent`), which should diff the returned
key set against the expected key set and route a mismatch to
`needs_review`. This is an open decision for B2, not a gap in B1.

### Skipped (explicitly out of scope per fix instructions)

- Older/trailer/diplomatic plate counterexamples — spec already documents this as an acknowledged gap pending the golden dataset.
- Non-ISO date shape (`DD/MM/YYYY`) reaching the schema un-normalized — spec already documents this as an assumption (normalization happens upstream).
- Full monorepo suite against `packages/db` — not re-run in this batch (no `packages/db` files touched; `packages/db` is out of scope per the fix constraints).

### Remaining Tasks

None — all 20 tasks (15 original + 5 fix-batch) complete.

### Status (batch 2)

20/20 tasks complete. All 3 CRITICAL findings from `verify-report.md` resolved with RED→GREEN evidence. Ready for re-verify.
