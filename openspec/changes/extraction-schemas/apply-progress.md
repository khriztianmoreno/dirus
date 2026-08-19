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

## Status

15/15 tasks complete. Ready for verify.
