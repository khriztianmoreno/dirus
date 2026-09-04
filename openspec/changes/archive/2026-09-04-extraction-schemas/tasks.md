# Tasks: Extraction schemas (caratula, cedula, tarjeta_propiedad)

## Review Workload Forecast

- 400-line budget risk: Low (338 changed lines, code + tests, in `packages/schemas` only)
- Chained PRs recommended: No
- Decision needed before apply: No

## Phase 1: Shared primitives

- [x] 1.1 Add `zod` as a plain npm dependency to `packages/schemas/package.json` (not `workspace:*` — package must keep zero workspace dependencies)
- [x] 1.2 Write `packages/schemas/src/primitives.ts`: Colombian plate, cédula number, doc type enum, ISO date (real-calendar-date refine), COP currency literal, COP amount decimal string, insurer line enum, insurer name, full name

## Phase 2: Document schemas (Strict TDD: RED → GREEN per file)

- [x] 2.1 `packages/schemas/test/caratula.test.ts` — complete example, partial example, malformed plate/line/currency/date/endDate-before-startDate/premiumAmount
- [x] 2.2 `packages/schemas/src/caratula.ts` — `caratulaSchema` (→ `policies` + policyholder `contacts` upsert), all fields optional, `.refine` for endDate >= startDate
- [x] 2.3 `packages/schemas/test/cedula.test.ts` — complete example, partial example, malformed docNumber (short/long/non-numeric), malformed docType
- [x] 2.4 `packages/schemas/src/cedula.ts` — `cedulaSchema` (→ `contacts`), docType fixed to `"CC"`
- [x] 2.5 `packages/schemas/test/tarjeta-propiedad.test.ts` — complete example (car), motorcycle plate variant, partial example, malformed plate/docNumber/docType
- [x] 2.6 `packages/schemas/src/tarjeta-propiedad.ts` — `tarjetaPropiedadSchema` (→ `policies.plate` + owner `contacts` upsert)

## Phase 3: Barrel and typecheck wiring

- [x] 3.1 Update `packages/schemas/src/index.ts` to re-export primitives + the three document schemas
- [x] 3.2 Update `packages/schemas/tsconfig.json` to include `test/**/*.ts`

## Phase 4: Verification

- [x] 4.1 `pnpm --filter @dirus/schemas exec vitest run` — 25/25 passing
- [x] 4.2 `pnpm -r run typecheck` — all 8 packages/apps clean
- [x] 4.3 `pnpm run lint` — clean
- [x] 4.4 `pnpm run lint:deps` — clean, `packages/schemas` still zero workspace dependencies (`packages/config/test/dependency-rule.test.ts` passes)
- [x] 4.5 Full monorepo suite against ephemeral `pgvector/pgvector:pg17` container — 122/122 passing (93 `packages/db` baseline unchanged + 4 `packages/config` + 25 `packages/schemas` new)

## Phase 5: Fix CRITICAL findings from sdd-verify (routed back from `verify-report.md`)

- [x] 5.1 Fix `packages/schemas/src/tarjeta-propiedad.ts` — `ownerDocNumber` now validates per `ownerDocType` (`superRefine` + `OWNER_DOC_NUMBER_PATTERNS`), not a single cédula-shaped regex. Fixes false rejection of valid `PA`/`NIT`/`CE`/`TI` owner numbers.
- [x] 5.2 Add `packages/schemas/test/primitives.test.ts` — proves plate normalisation (`.trim().toUpperCase()`) precedes format validation for lowercase, whitespace-padded, and mixed-case input. RED/GREEN confirmed via temporary mutation.
- [x] 5.3 Add unknown-key stripping tests to all three schema test files (`caratula.test.ts`, `cedula.test.ts`, `tarjeta-propiedad.test.ts`) — locks in current non-strict behavior; `.strict()` deliberately NOT added (see spec's "Open Decision" section). RED/GREEN confirmed via temporary `.strict()` mutation.
- [x] 5.4 Add malformed-`insurer` and malformed-`fullName` tests (WARNING, min-length implemented but previously untested) to `caratula.test.ts` and `cedula.test.ts`. RED/GREEN confirmed via temporary `.min(2)` removal.
- [x] 5.5 Re-run full verification suite: `pnpm --filter @dirus/schemas exec vitest run` (42/42), `pnpm -r run typecheck` (8/8 clean), `pnpm run lint` (clean), `pnpm run lint:deps` (clean, 77 modules/159 dependencies, zero violations)
