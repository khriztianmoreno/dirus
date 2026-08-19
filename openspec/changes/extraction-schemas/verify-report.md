## Verification Report

**Change**: extraction-schemas (B1)
**Version**: N/A (fast-forward change; spec written after apply)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 15 |
| Tasks complete | 15 |
| Tasks incomplete | 0 |

All 15 tasks in `tasks.md` are checked and match the code state in `packages/schemas/`. `apply-progress.md` reports "15/15 tasks complete" and this was independently confirmed by reading `packages/schemas/src/*.ts` and `packages/schemas/test/*.ts`.

### Build & Tests Execution

**Typecheck**: ✅ Passed — `pnpm -r run typecheck` (8/8 workspace projects report `Done`, zero errors)

**Lint**: ✅ Passed — `pnpm run lint` (`eslint .`, zero output)

**Lint:deps**: ✅ Passed — `pnpm run lint:deps` → `no dependency violations found (76 modules, 157 dependencies cruised)`. Confirms `packages/schemas` still declares zero `workspace:*` dependencies (only `zod: ^4.4.3`, plain npm dependency).

**Tests (schemas package)**: ✅ 25 passed / 0 failed / 0 skipped
```text
$ pnpm --filter @dirus/schemas exec vitest run
 ✓ test/cedula.test.ts (7 tests) 3ms
 ✓ test/tarjeta-propiedad.test.ts (8 tests) 3ms
 ✓ test/caratula.test.ts (10 tests) 4ms
 Test Files  3 passed (3)
      Tests  25 passed (25)
```

**Tests (config package, dependency-rule)**: ✅ 4 passed / 0 failed
```text
$ pnpm --filter @dirus/config exec vitest run
 ✓ test/dependency-rule.test.ts (4 tests) 134ms
```

**Full monorepo suite (incl. `packages/db`)**: NOT re-run in this verify pass — it requires a live Postgres (`pgvector/pgvector:pg17`) and was already executed and reported in `apply-progress.md` (122/122 passed: 93 `packages/db` baseline + 4 `packages/config` + 25 `packages/schemas`). This verify pass independently confirms the `@dirus/schemas` (25) and `@dirus/config` (4) portions directly; the `packages/db` (93) portion is taken on the apply-phase report's word, not independently re-executed here. Flagged as a scope limitation, not a failure.

**Coverage**: Not available — no coverage tool configured for `packages/schemas` (`vitest run` without `--coverage`; no coverage script in `package.json`).

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Optional On Presence, Strict On Shape | Empty extraction is valid | `caratula.test.ts`, `cedula.test.ts`, `tarjeta-propiedad.test.ts` — "empty object" | ✅ COMPLIANT |
| Five Load-Bearing Fields Validate | Malformed value in a load-bearing field is rejected | cédula: `cedula.test.ts` "shorter than 6 digits"; plate/date: `caratula.test.ts` | ⚠️ PARTIAL — no test rejects a 1-char `insurer` or `fullName`; `.min(2)` exists in `primitives.ts` but is unverified by any test |
| Colombian Plate Format | Car/moto accepted, malformed rejected | `caratula.test.ts` malformed plate; `tarjeta-propiedad.test.ts` complete/motorcycle/malformed-suffix/too-short | ✅ COMPLIANT (format itself remains unconfirmed against a golden dataset — correctly stated as such, not asserted settled) |
| Cédula Number Format | Out-of-range / punctuated numbers rejected | `cedula.test.ts` short/long/non-numeric; `tarjeta-propiedad.test.ts` punctuation | ✅ COMPLIANT for the stated scenario. Separately: see CRITICAL finding below — the same regex is misapplied to `tarjeta-propiedad.ownerDocNumber` regardless of `ownerDocType` |
| Document Type Closed Set | Type outside set, or wrong type for cédula, rejected | `cedula.test.ts` "docType other than CC"; `tarjeta-propiedad.test.ts` "ownerDocType outside enum" | ✅ COMPLIANT |
| Currency Locked To COP | Non-COP currency rejected | `caratula.test.ts` "rejects a non-COP currency" | ✅ COMPLIANT |
| Date Shape And Calendar Validity | Impossible date and inverted range rejected | `caratula.test.ts` "impossible calendar date", "endDate before startDate" | ✅ COMPLIANT for the tested scenario. Non-ISO shape (`DD/MM/YYYY`) reaching the schema un-normalized: no test — documented in spec as an assumption, not enforced |
| Premium Amount As Decimal String | Thousands separators / non-numeric rejected | `caratula.test.ts` "thousands separators", "non-numeric premiumAmount" | ✅ COMPLIANT |
| Normalisation Precedes Plate Validation | Lowercase, whitespace-padded plate accepted | none found | ❌ UNTESTED |
| Fields With No Destination Column Are Excluded | Extra fields absent from schema, silently stripped not rejected | none found (static-only: confirmed by reading `tarjeta-propiedad.ts` and `cedula.ts`, no such fields are declared) | ❌ UNTESTED |
| Scope Exclusions | Package has zero workspace dependencies | `packages/config/test/dependency-rule.test.ts` (4/4 passing, independently re-run) | ✅ COMPLIANT |

**Compliance summary**: 7/11 fully compliant with a passing covering test, 1/11 partial (untested sub-case), 2/11 untested (scenario exists in spec, no covering test), 1/11 static-only (dependency count, but has a real passing test).

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|---|---|---|
| `ownerDocType` / `ownerDocNumber` consistency in `tarjeta-propiedad.ts` | ❌ Defect confirmed | `ownerDocType: colombianDocTypeSchema.optional()` accepts `CC \| CE \| TI \| NIT \| PA`, but `ownerDocNumber: cedulaNumberSchema.optional()` unconditionally enforces `^\d{6,10}$` regardless of the chosen `docType`. A Colombian passport (`PA`) number is alphanumeric (e.g. `AB123456`) and cannot match a digits-only pattern; a NIT is conventionally written with a verification digit (e.g. `900123456-7`); a cédula de extranjería (`CE`) number may fall outside 6–10 digits. This is the exact anti-pattern the proposal's design principle warns against ("optional on presence, strict on shape" / avoid burning a Flash→Pro escalation on a schema bug misdiagnosed as model failure) — a genuine `PA`/`NIT` owner extraction will fail Zod validation even when correctly read. **`cedula.ts` is NOT affected**: it pins `docType` to the literal `"CC"` with documented rationale (a `cedula` doc_class can never yield `CE/TI/NIT/PA`), so `cedulaNumberSchema` is always applied to a `CC`-only context there, which is correct. |
| Field-to-column mapping | ✅ Confirmed | `caratulaSchema` fields map to `policies` (`insurer`, `line`, `policyNumber`, `plate`, `premiumAmount`, `currency`, `startDate`, `endDate`) and `contacts` (`insuredFullName`→`fullName`, `insuredDocNumber`→`docNumber`) per `packages/db/src/schema/policies.ts` and `contacts.ts`. `tarjetaPropiedadSchema.plate` maps to `policies.plate`; `ownerFullName`/`ownerDocNumber`/`ownerDocType` map to `contacts`. `cedulaSchema` maps directly to `contacts`. |
| Fields with no destination column excluded | ✅ Confirmed by source inspection | `tarjeta-propiedad.ts` has no `make`/`model`/`year`/`engineNumber`/`chassisNumber` fields; `cedula.ts` has no `dateOfBirth`/`placeOfBirth` fields. `packages/db/src/schema/policies.ts` and `contacts.ts` confirm no matching columns exist. Static evidence is solid; no test locks the stripping *behavior* in (see UNTESTED above). |
| `.strict()` not used on any of the three schemas | ⚠️ Design concern, confirmed | Grep of `packages/schemas/src/*.ts` for `.strict()` returns zero matches. Given the producer is a language model whose output keys are not guaranteed stable, a typo'd or hallucinated key (e.g. `ownerFullname` instead of `ownerFullName`) is silently stripped by Zod's default behavior — the schema still validates successfully, and the intended field simply reads as absent, indistinguishable from a genuinely illegible field. This removes a signal that would otherwise surface a real extraction/prompt bug. Given B2's escalation logic keys off validation *failure*, silent stripping means this class of error is invisible to that mechanism entirely — it degrades data quality without ever triggering the Flash→Pro safety net the schema was designed to protect. Worth reconsidering `.strict()` (or logging unrecognized keys) before B2 lands, though this is a design tradeoff, not a shape-validation bug. |
| Plate normalisation (`.trim().toUpperCase()`) | ✅ Correct by inspection, ❌ unverified by test | `primitives.ts:24-28` chains `.trim().toUpperCase().regex(...)` — Zod v4 applies these in declaration order, so a lowercase or whitespace-padded plate is normalized before the regex runs. Behavior appears correct, but zero test exercises it; see UNTESTED above. |
| Insurer / fullName min-length | ✅ Implemented, ❌ unverified by test | `insurerNameSchema` and `fullNameSchema` both use `.trim().min(2, ...)` in `primitives.ts`. No test in `caratula.test.ts` or `cedula.test.ts`/`tarjeta-propiedad.test.ts` passes a 1-char value to either field. |
| Golden-dataset-unconfirmed formats recorded as unconfirmed, not settled | ✅ Confirmed | `spec.md` labels the Plate, Cédula Number, Doc Type, Currency, Date, and Premium Amount requirements `(unconfirmed against golden dataset)` in their headings, matching `proposal.md`'s "Field formats chosen without repo precedent" table. None is asserted as a settled fact. |
| Non-goals hold | ✅ Confirmed | No model/AI SDK calls, no confidence-threshold or `needs_review` logic, no DB writes/migrations (nothing under `packages/db` changed — confirmed via `git status`/file reads), no `factura` schema (`index.ts` re-exports only `primitives`, `caratula`, `cedula`, `tarjeta-propiedad`). |

### Coherence (Design)
No `design.md` exists for this fast-forward change (confirmed — `apply-progress.md` states this explicitly, and no such file was found in `openspec/changes/extraction-schemas/`). Design coherence check is skipped per the graceful-degradation rule; implementation was checked against `proposal.md` and `docs/ARCHITECTURE.md` directly instead, and no deviations from `proposal.md` were found beyond the `ownerDocType`/`ownerDocNumber` defect above, which `proposal.md` does not call out (the proposal's "Field formats" table flags the cédula-number *range* as unconfirmed, but does not flag the doc-type-dependent format mismatch specifically).

### TDD Compliance
| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | `apply-progress.md` has a "TDD Cycle Evidence" table for all 3 schemas |
| All tasks have tests | ✅ | 3/3 schema tasks have test files (`caratula.test.ts`, `cedula.test.ts`, `tarjeta-propiedad.test.ts`) |
| RED confirmed (tests exist) | ✅ | All 3 test files exist in `packages/schemas/test/` |
| GREEN confirmed (tests pass) | ✅ | 25/25 pass on execution in this verify pass, matching the reported 10/7/8 split |
| Triangulation adequate | ⚠️ | Reasonable per-field coverage overall, but the "Five Load-Bearing Fields" and "Normalisation" requirements each have multiple spec scenarios covered by zero or partial test cases (see UNTESTED/PARTIAL rows above) |
| Safety Net for modified files | ✅ | All schema files are new (`Created`, not `Modified`) per `apply-progress.md`'s Files Changed table — "N/A (new)" is correct, not a gap |

**TDD Compliance**: 5/6 checks fully passed, 1 partial (triangulation gap on 2 requirements)

### Assertion Quality
Reviewed all 25 test cases across `caratula.test.ts`, `cedula.test.ts`, `tarjeta-propiedad.test.ts`. Every test calls `schema.safeParse(...)` (production code) and asserts on `.success` (a real, non-tautological, non-type-only boolean outcome tied to actual validation behavior). No tautologies, no ghost loops, no assertion-free tests, no CSS/implementation-detail coupling, no mocks.

**Assertion quality**: ✅ All assertions verify real behavior

### Issues Found

**CRITICAL**
1. **Real defect, not just a test gap** — `packages/schemas/src/tarjeta-propiedad.ts`: `ownerDocNumber` is validated with `cedulaNumberSchema` (`^\d{6,10}$`) unconditionally, while `ownerDocType` accepts `CE | TI | NIT | PA` in addition to `CC`. A correctly-extracted `PA` (passport, alphanumeric) or `NIT` (with verification digit) owner number will fail validation, triggering the exact costly Flash→Pro escalation the design explicitly set out to avoid. This is a production-facing bug, ranked above the untested-scenario findings below because it will produce a *wrong result* (false rejection of valid data) rather than merely lacking proof of correctness. Scoped correctly to `tarjeta-propiedad.ts` only — `cedula.ts` is unaffected (confirmed: `docType` there is pinned to the literal `"CC"`).
2. Spec requirement "Normalisation Precedes Plate Validation" has a declared scenario (lowercase/whitespace-padded plate) with zero covering test. Per this project's verification rules, an untested spec scenario is CRITICAL regardless of how likely the code is correct by inspection — this is precisely the case the spec calls out as "the difference between a schema bug and an apparent model failure in the metrics."
3. Spec requirement "Fields With No Destination Column Are Excluded" has a declared scenario (extra keys silently stripped, not rejected) with zero covering test. Static inspection confirms the excluded fields are indeed absent from the schema and that Zod's default (non-strict) behavior would strip rather than reject unknown keys, but no test locks this in, and `.strict()` is not used anywhere — meaning a typo'd/unstable key from the LLM producer would silently vanish with no signal, which is a real design risk given the producer's output keys are not guaranteed stable.

**WARNING**
1. Spec requirement "Five Load-Bearing Fields Validate" — no test rejects a malformed `insurer` or `fullName` (both are only 1 char below the `.min(2)` threshold away from a real gap; behavior is implemented but unverified).
2. No counterexample test for older / trailer / diplomatic plates — self-documented in `spec.md` as an acknowledged, unconfirmed gap rather than a silent omission.
3. No test covers a non-ISO date shape (e.g. `DD/MM/YYYY`) reaching the schema un-normalized — self-documented in `spec.md` as an assumption (normalization happens upstream), not schema-enforced.
4. `.strict()` is not used on any of the three schemas — separate from the untested-scenario CRITICAL above, this is a design-level question worth resolving before B2 lands: should a typo'd extraction key be silently dropped, or surfaced? Given the producer is a model, not a human filling a form, silent stripping removes a useful signal.
5. Full monorepo suite (`packages/db`, 93 tests) was not independently re-executed in this verify pass; taken on `apply-progress.md`'s word only. `@dirus/schemas` (25) and `@dirus/config` (4) were independently re-run and confirmed.

**SUGGESTION**
1. Consider adding a `README.md` or module-level doc comment cross-referencing the "field formats need golden-dataset confirmation" table so it is discoverable from the package itself, not only from `proposal.md`.

### Verdict
**FAIL**

One real production defect (`tarjeta-propiedad.ts` `ownerDocType`/`ownerDocNumber` mismatch — will falsely reject valid `PA`/`NIT` owner data) plus two spec-declared scenarios (plate normalisation, unknown-key stripping) with zero covering tests block a clean PASS. All 15 tasks are complete, 25/25 written tests pass, and typecheck/lint/lint:deps are clean — the implementation is close and well-structured, but does not yet fully satisfy its own spec. Recommend routing back to `sdd-apply` to fix the `tarjeta-propiedad.ts` doc-number/doc-type coupling and add the two missing test cases before archiving.
