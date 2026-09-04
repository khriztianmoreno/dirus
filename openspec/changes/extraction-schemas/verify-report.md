# Verify Report: extraction-schemas (B1)

**Date**: 2026-09-04
**Verifier**: sdd-verify (re-run against post-fix state, commit `dd0ff48`)
**Mode**: OpenSpec (fast-forward trail — proposal/tasks/spec/apply-progress read directly from `openspec/changes/extraction-schemas/`)

## Context

This is a re-verification. A prior run (see git log `c6bc9cc`) produced a FAIL
verdict with three CRITICAL findings against commit `1bf4036`:

1. `tarjeta-propiedad.ts` `ownerDocNumber` validated with a single
   cédula-shaped regex regardless of `ownerDocType`, rejecting valid `PA`
   and `NIT` values.
2. Plate-normalisation scenario (trim/uppercase before regex) had zero test
   coverage.
3. Unknown-key-stripping scenario had zero test coverage.

Commit `dd0ff48` claims to fix all three. This report re-derives the
verdict from current code and test runs — it does not take that commit
message on faith.

## Task Completeness

All 5 phases in `tasks.md` are checked, including the Phase 5 items added
specifically to close the prior CRITICAL findings (5.1–5.5). Task
completion matches code state — verified by reading the referenced files
directly (see below), not by trusting the checkboxes.

## Command Evidence (executed in this session)

| Command | Result |
|---|---|
| `pnpm --filter @dirus/schemas exec vitest run` | **42/42 passed**, 4 files (`caratula.test.ts` 13, `cedula.test.ts` 9, `tarjeta-propiedad.test.ts` 17, `primitives.test.ts` 3) |
| `pnpm -r run typecheck` | **8/8 packages/apps clean** (`packages/schemas`, `packages/config`, `apps/api`, `apps/dashboard`, `apps/jobs`, `packages/agents`, `packages/db`, `packages/integrations`) |
| `pnpm run lint` | clean, no output/errors |
| `pnpm run lint:deps` | clean — "no dependency violations found (77 modules, 159 dependencies cruised)" |
| `pnpm --filter @dirus/config exec vitest run` | `dependency-rule.test.ts` 4/4 passed — confirms `packages/schemas` still has zero workspace dependencies |

`packages/schemas/package.json` inspected directly: `dependencies: { "zod": "^4.4.3" }`, `devDependencies: {}` — no `workspace:*` entry.

## Finding 1 — Owner document number defect: RESOLVED, verified correct

`packages/schemas/src/tarjeta-propiedad.ts` now validates `ownerDocNumber`
via `superRefine` against `OWNER_DOC_NUMBER_PATTERNS`, keyed by
`ownerDocType` (defaulting to `CC` when absent):

- `CC: /^\d{6,10}$/`, `TI: /^\d{6,11}$/`, `CE: /^\d{6,12}$/`,
  `NIT: /^\d{6,10}(-\d)?$/`, `PA: /^[A-Za-z0-9]{6,12}$/`

This is coherent with `primitives.ts`'s `cedulaNumberSchema`
(`^\d{6,10}$`, used unconditionally in `cedula.ts` — correct, because
`cedula.docType` is pinned to the literal `"CC"` there, so no per-type
branching is needed in that file). The `CC` branch of
`OWNER_DOC_NUMBER_PATTERNS` matches `cedulaNumberSchema` exactly, so the
two files do not silently diverge on what "a valid CC number" means.

Every pattern that has no repo precedent is marked with a `NEEDS
CONFIRMATION` comment block explaining the reasoning and citing the golden
dataset as the eventual disproof mechanism (`primitives.ts` lines 19-23,
30-33, 39-42, 61-64; `tarjeta-propiedad.ts` lines 4-16). This matches the
project convention already established by the un-fixed parts of
`primitives.ts` — not a new pattern invented only for the fix.

**Test verification (not just source inspection)**: `tarjeta-propiedad.test.ts`
has one positive + one negative test per non-CC docType (`PA`, `NIT`,
`CE`, `TI`), plus a default-to-CC test and a "CC behavior unchanged"
regression test. Ran the suite and confirmed all pass. These tests
discriminate real behavior — e.g. `AB123456` (alphanumeric) against `PA`
succeeds, but the identical pattern of characters against implicit-CC
(no `ownerDocType` given) explicitly fails in a dedicated test — so a
regression that reverted to the single-regex bug would fail this file, not
just pass vacuously.

**Verdict on Finding 1: RESOLVED.**

## Finding 2 — Plate normalisation: RESOLVED, verified discriminating

`packages/schemas/test/primitives.test.ts` (new file, 3 tests) asserts not
just `.success === true` but the normalised **value** —
`colombianPlateSchema.safeParse("abc123").data === "ABC123"`, same for
whitespace-padded and mixed-case input. A test that only checked
`.success` would not have caught the original gap (any string that merely
happens to satisfy the regex post-normalisation would pass); asserting the
returned value is what makes this discriminating. Per `tasks.md` 5.2, the
authors report RED/GREEN confirmation by temporarily removing
`.trim().toUpperCase()` and observing all 3 fail — consistent with what a
direct read of the regex-only path would produce (a bare lowercase or
padded string would fail `/^[A-Z]{3}\d{2}[A-Z0-9]$/` without those
Zod pipeline steps).

**Verdict on Finding 2: RESOLVED.**

## Finding 3 — Unknown-key stripping: RESOLVED, verified discriminating

All three schema test files now include a "silently strips an unknown
key" test that asserts both `result.success === true` AND
`Object.keys(result.data)` equals exactly the known-key subset (not just
"does not have the unknown key" — the stronger assertion also catches a
schema that grew unintended additional keys). This directly backs the
spec's "Fields With No Destination Column Are Excluded" requirement and
its "Open Decision" section (deliberately no `.strict()`). Confirmed by
running the suite: all pass.

**Verdict on Finding 3: RESOLVED.**

## Spec Compliance Matrix (openspec/changes/extraction-schemas/specs/extraction-schemas/spec.md)

| Requirement | Scenario | Test | Status |
|---|---|---|---|
| Optional On Presence, Strict On Shape | Empty extraction valid | `{}` tests in all 3 schema test files | PASS |
| Five Load-Bearing Fields | Malformed value rejected | insurer/name/docNumber min-length + range tests | PASS |
| Colombian Plate Format | Car/moto accepted, malformed rejected | `caratula.test.ts`, `tarjeta-propiedad.test.ts` | PASS (gap documented: older/trailer/diplomatic plates untested — explicitly flagged in spec as unconfirmed, not silently missing) |
| Cédula Number Format | Out-of-range/punctuated rejected | `cedula.test.ts` short/long/non-numeric | PASS |
| Owner Doc Number Depends On Owner Doc Type | Valid per-type accepted | `tarjeta-propiedad.test.ts` PA/NIT/CE/TI | PASS |
| — | Malformed per-type rejected | `tarjeta-propiedad.test.ts` PA/NIT/CC-punctuation | PASS |
| — | Absent type defaults to CC | `tarjeta-propiedad.test.ts` default test | PASS |
| Document Type Closed Set | Outside set / wrong type for cédula rejected | `cedula.test.ts`, `tarjeta-propiedad.test.ts` | PASS |
| Currency Locked To COP | Non-COP rejected | `caratula.test.ts` | PASS |
| Date Shape And Calendar Validity | Impossible date / inverted range rejected | `caratula.test.ts` | PASS (gap documented: non-ISO shape reaching schema un-normalized untested — explicitly flagged, assumed upstream) |
| Premium Amount As Decimal String | Separators/non-numeric rejected | `caratula.test.ts` | PASS |
| Normalisation Precedes Plate Validation | Lowercase/whitespace accepted, value normalised | `primitives.test.ts` (new) | PASS |
| Fields With No Destination Column Excluded | Unknown key stripped, not rejected | all 3 schema test files (new tests) | PASS |
| Scope Exclusions | Zero workspace dependencies | `packages/config/test/dependency-rule.test.ts` | PASS |

Every requirement in the spec has at least one passing, discriminating,
runtime-executed test. No CRITICAL findings.

## Issues

### CRITICAL
None.

### WARNING
- Two format assumptions remain explicitly unconfirmed against a real
  golden dataset (Colombian plate regex, cédula/owner-doc-number digit
  ranges) — this is disclosed by the authors themselves in `proposal.md`'s
  "Field formats chosen without repo precedent" table and in code comments
  (`NEEDS CONFIRMATION`), and is correctly scoped as B2's validation gate,
  not this change's responsibility. Not a defect; flagged here only so the
  next phase doesn't lose the thread.
- The non-ISO date shape gap (`DD/MM/YYYY` reaching the schema
  un-normalized) is explicitly documented as untested and assumed handled
  upstream. Same disposition as above — a known, disclosed gap, not a
  silent one.

### SUGGESTION
- None beyond what's already tracked as an "Open Decision" in the spec
  (`.strict()` tradeoff deferred to B2 — appropriately scoped, not a gap
  in this package).

## Verdict

**PASS**

All three CRITICAL findings from the prior verify run are resolved, with
runtime test evidence — not just source-level claims — for each. The fix
in `tarjeta-propiedad.ts` is coherent with `cedula.ts` and `primitives.ts`
(same `CC` pattern reused, no silent divergence), and every
unconfirmed-format assumption is explicitly commented as such rather than
presented as settled. Test suite: 42/42 passing across 4 files. Typecheck:
8/8 clean. Lint: clean. Lint:deps: clean, zero workspace-dependency
violations. All spec requirements have discriminating, currently-passing
test coverage. Ready for `sdd-archive`.
