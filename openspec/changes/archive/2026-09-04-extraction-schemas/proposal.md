# Proposal: Extraction schemas (caratula, cedula, tarjeta_propiedad)

> Fast-forward change (B1 in `openspec/ROADMAP.md`). Produced directly from the
> ticket + `docs/ARCHITECTURE.md`; propose/spec/design were skipped per
> orchestrator instruction. This file, `tasks.md` and `apply-progress.md`
> stand in for the full SDD trail.

## Intent

B2 (`ingestion-agent`, blocked on the golden dataset) needs typed, validated
shapes for what the multimodal extraction step returns before it can write
anything to `contacts`/`policies`. `packages/schemas` is currently an empty
typed shell. This change fills it with Zod schemas for the three document
classes the MVP ingests today (docs/ARCHITECTURE.md line 255):
`caratula | cedula | tarjeta_propiedad`. `factura` is out of scope.

## Scope

### In Scope
- Zod schemas: `caratulaSchema`, `cedulaSchema`, `tarjetaPropiedadSchema`,
  plus shared Colombian-format primitives (`packages/schemas/src/primitives.ts`).
- Field names that map recognisably onto `packages/db` columns
  (`policies`, `contacts`).
- Strict TDD test coverage: complete example, partial (real-world-missing-
  fields) example, and malformed-value rejection per field.

### Out of Scope
- The extraction agent itself, model calls, AI SDK wiring — B2, blocked on
  the golden dataset.
- Confidence-threshold / `needs_review` logic — B2's concern; these schemas
  only describe shape.
- DB writes, migrations, changes to `packages/db`.
- `factura` schema.

## Capabilities

### New Capabilities
- `extraction-schemas`: Zod schemas for the three MVP document classes,
  zero-workspace-dependency package (`packages/schemas`).

### Modified Capabilities
- None.

## The design decision that matters most: optionality

Every field defaults to **optional** unless the repo establishes it as
always present. B2 escalates Gemini Flash → Pro on a Zod validation
failure. A field marked required but genuinely absent or illegible on a
real document turns each of those into a validation failure — burning cost
and latency on a schema bug that presents as the model underperforming.

Rule applied throughout: **optional on presence, strict on shape.** A field
that is present must be well-formed; the schema's job is to reject
malformed values, not to demand a complete document.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/schemas/src/primitives.ts` | New | Shared Colombian-format validators (plate, cédula number, doc type, ISO date, COP amount/currency, insurer line) |
| `packages/schemas/src/caratula.ts` | New | Policy cover page → `policies` + policyholder `contacts` upsert |
| `packages/schemas/src/cedula.ts` | New | National ID → `contacts` |
| `packages/schemas/src/tarjeta-propiedad.ts` | New | Vehicle registration card → `policies.plate` + owner `contacts` upsert |
| `packages/schemas/src/index.ts` | Modified | Barrel now re-exports the four modules above |
| `packages/schemas/package.json` | Modified | Adds `zod` as a plain npm dependency (not `workspace:*` — the package must keep zero workspace dependencies per `packages/config/test/dependency-rule.test.ts`) |
| `packages/schemas/tsconfig.json` | Modified | Includes `test/**/*.ts` so tests typecheck, matching `packages/config`/`packages/db` convention |

## Fields with no destination column (excluded, not invented)

- **tarjeta_propiedad**: make, model, year, engine number, chassis number
  are printed on a real card but have no column in `packages/db` (only
  `policies.plate` exists for vehicle data today). Deliberately excluded
  rather than inventing a column.
- **cedula**: date of birth / place of birth are printed on a real card but
  `contacts` has no matching column. Deliberately excluded.

## Field formats chosen without repo precedent (need confirmation against the golden dataset)

| Field | Chosen format | Why conservative | Where it will be disproven first |
|---|---|---|---|
| Colombian plate | `^[A-Z]{3}\d{2}[A-Z0-9]$` (covers cars `ABC123` and motorcycles `ABC12D`) | No format is documented in the repo; this is the commonly cited current DMV pattern | A real plate photo with a format not covered (older plates, trailers, diplomatic plates) |
| Cédula number | `^\d{6,10}$`, digits only | Historic range is 6–10 digits; no punctuation | Cards with dots/dashes in the printed number, or numbers outside this range |
| `docType` closed set | `CC \| CE \| TI \| NIT \| PA` | Matches Colombian ID document types; `cedula` doc_class is pinned to `CC` only | A `tarjeta_propiedad` owned by an entity with a doc type outside this set |
| Currency | closed literal `"COP"` | Architecture only ever mentions COP (`policies.currency` default) | Any future non-COP policy |
| Date | `YYYY-MM-DD`, validated as a real calendar date | Matches drizzle's `date` column shape; normalization to ISO is assumed to happen before schema validation | A document photographed in `DD/MM/YYYY` that reaches the schema un-normalized |
| Premium amount | decimal string matching `numeric(14,2)`, e.g. `"1250000.00"` | Avoids floating-point rounding; mirrors how drizzle numeric columns are typically passed | An extraction pipeline that produces a JS number instead of a string |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Plate/cédula regex too strict for real documents | Medium | Table above flags them explicitly; first golden-dataset pass (B2) is the validation gate |
| Zod major version drift before B2 lands | Low | Pinned `^4.4.3`, semver-caret allows patches only within v4 |
