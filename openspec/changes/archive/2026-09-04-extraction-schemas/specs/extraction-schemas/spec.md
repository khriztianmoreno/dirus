# Extraction Schemas Specification

## Purpose

Define the acceptance contract for `packages/schemas`: Zod validation shapes
for the three MVP `doc_class` values (`docs/ARCHITECTURE.md:255`) that the
ingestion agent (B2) must satisfy before writing to `extractions`,
`contacts`, `policies` (`docs/ARCHITECTURE.md:121`). Written after a
fast-forward apply to make the change verifiable; where the implementation
does not satisfy a requirement below, that mismatch is called out, not
silently reconciled.

## Requirements

### Requirement: Optional On Presence, Strict On Shape
Every field in `caratulaSchema`, `cedulaSchema`, `tarjetaPropiedadSchema`
MUST be optional. A field that IS present MUST fail validation if malformed.
The system MUST NOT require any field's presence, because B2 escalates
Flash → Pro on Zod failure, and a required-but-absent field would burn cost
on a schema bug misdiagnosed as model failure.

#### Scenario: Empty extraction is valid
- GIVEN an empty object
- WHEN parsed against any of the three schemas
- THEN validation succeeds
(Covered: `caratula.test.ts`, `cedula.test.ts`, `tarjeta-propiedad.test.ts` — "empty object" tests)

### Requirement: Five Load-Bearing Fields Validate Per `docs/ARCHITECTURE.md:369`
The system MUST validate nombre (`fullNameSchema`, min 2 chars), cédula
(`cedulaNumberSchema`, 6-10 digits), placa (`colombianPlateSchema`),
vigencia (`isoDateSchema` pair with `endDate >= startDate`), and
aseguradora (`insurerNameSchema`, min 2 chars) — the fields H3
precision/recall is measured against.

#### Scenario: Malformed value in a load-bearing field is rejected
- GIVEN a value shorter than each field's minimum (e.g. a 1-character name, a 3-digit cédula)
- WHEN parsed
- THEN validation fails
(Covered: `caratula.test.ts` "rejects an insurer shorter than 2 characters", "rejects an insuredFullName shorter than 2 characters"; `cedula.test.ts` "rejects a fullName shorter than 2 characters"; `cedula.test.ts` short/long/non-numeric docNumber tests)

### Requirement: Colombian Plate Format (unconfirmed against golden dataset)
Plates MUST match `^[A-Z]{3}\d{2}[A-Z0-9]$` after normalisation, covering
car (`ABC123`) and motorcycle (`ABC12D`) formats.

#### Scenario: Standard car and motorcycle plates accepted, malformed rejected
- GIVEN `ABC123` (car), `ABC12D` (motorcycle), and `12ABC3` (malformed)
- WHEN parsed
- THEN the first two succeed and the third fails
(Covered: `caratula.test.ts` malformed plate; `tarjeta-propiedad.test.ts` motorcycle + malformed-suffix + too-short)
(Gap: older plates, trailer plates, diplomatic plates have no counterexample test)

### Requirement: Cédula Number Format (unconfirmed against golden dataset)
Cédula numbers MUST match `^\d{6,10}$`, digits only. This requirement is
scoped to `cedulaSchema.docNumber`, whose `docType` is always pinned to the
literal `"CC"` (a "cedula" `doc_class` never yields `CE/TI/NIT/PA`), so
`docType` never varies there.

#### Scenario: Out-of-range or punctuated numbers rejected
- GIVEN a 3-digit number, a 12-digit number, and `793-456-12`
- WHEN parsed against `cedulaSchema.docNumber`
- THEN all three fail
(Covered: `cedula.test.ts` short/long/non-numeric)

### Requirement: Owner Document Number Format Depends On Owner Document Type (unconfirmed against golden dataset)
`tarjetaPropiedadSchema.ownerDocNumber` MUST validate against a pattern
selected by `ownerDocType`, not a single fixed regex, because `ownerDocType`
is a closed set of five values (`CC | CE | TI | NIT | PA`) whose real-world
number shapes differ:
- `CC` / `TI`: digits only, `^\d{6,10}$` / `^\d{6,11}$`
- `CE`: digits only, widened to `^\d{6,12}$` (foreign-national ID numbers are
  not reliably bounded at 10 digits)
- `NIT`: `^\d{6,10}(-\d)?$` — an optional hyphenated single verification
  digit, the conventional printed format (e.g. `900123456-7`)
- `PA`: `^[A-Za-z0-9]{6,12}$` — alphanumeric, per ICAO passport number
  conventions, never digits-only (e.g. `AB123456`)
- When `ownerDocType` is absent, the `CC` pattern applies by default,
  preserving the schema's pre-fix behavior for the common case.

This corrects a defect where a single cédula-shaped regex was applied
regardless of `ownerDocType`, causing a correctly-extracted `PA` or `NIT`
owner number to be rejected — the exact "schema bug misdiagnosed as model
failure" anti-pattern this package's design principle exists to prevent.

#### Scenario: Valid owner numbers for each non-CC docType are accepted
- GIVEN `ownerDocType: "PA"` with `ownerDocNumber: "AB123456"`, `ownerDocType: "NIT"` with `ownerDocNumber: "900123456-7"`, `ownerDocType: "CE"` with a 12-digit number, and `ownerDocType: "TI"` with an 11-digit number
- WHEN parsed against `tarjetaPropiedadSchema`
- THEN all four succeed
(Covered: `tarjeta-propiedad.test.ts` — "accepts a valid PA...", "accepts a valid NIT...", "accepts a valid CE...", "accepts a valid TI...")

#### Scenario: Malformed owner numbers for a given docType are rejected
- GIVEN a `PA` number too short to be alphanumeric-shaped, a `NIT` number with a two-digit verification segment, and a `CC` number with punctuation
- WHEN parsed against `tarjetaPropiedadSchema`
- THEN all three fail
(Covered: `tarjeta-propiedad.test.ts` — "rejects a PA...", "rejects a NIT...", "still rejects a CC...")

#### Scenario: ownerDocType absent defaults to the CC pattern
- GIVEN `ownerDocNumber: "AB123456"` with no `ownerDocType`
- WHEN parsed against `tarjetaPropiedadSchema`
- THEN validation fails (alphanumeric value does not match the CC digit-only default)
(Covered: `tarjeta-propiedad.test.ts` — "defaults to the CC digit pattern when ownerDocType is absent")

### Requirement: Document Type Closed Set (unconfirmed against golden dataset)
`docType` MUST be one of `CC | CE | TI | NIT | PA`; `cedula.docType` MUST be
fixed to the literal `"CC"`.

#### Scenario: Type outside the set, or wrong type for cédula, is rejected
- GIVEN `docType: "SSN"` on tarjeta_propiedad, and `docType: "CE"` on cedula
- WHEN parsed
- THEN both fail
(Covered: `cedula.test.ts`, `tarjeta-propiedad.test.ts`)

### Requirement: Currency Locked To COP (unconfirmed against golden dataset)
`currency` MUST accept only the literal `"COP"`.

#### Scenario: Non-COP currency rejected
- GIVEN `currency: "USD"`
- WHEN parsed
- THEN validation fails
(Covered: `caratula.test.ts`)

### Requirement: Date Shape And Calendar Validity (unconfirmed against golden dataset)
Dates MUST match `YYYY-MM-DD` and MUST be real calendar dates; `endDate`
MUST NOT precede `startDate`.

#### Scenario: Impossible date and inverted range rejected
- GIVEN `endDate: "2026-02-30"`, and `startDate` after `endDate`
- WHEN parsed
- THEN both fail
(Covered: `caratula.test.ts`)
(Gap: no test covers a non-ISO shape such as `DD/MM/YYYY` reaching the schema un-normalized — assumed handled upstream)

### Requirement: Premium Amount As Decimal String (unconfirmed against golden dataset)
`premiumAmount` MUST be a string matching `^\d{1,12}(\.\d{1,2})?$`.

#### Scenario: Thousands separators and non-numeric values rejected
- GIVEN `"1,250,000.00"` and `"abc"`
- WHEN parsed
- THEN both fail
(Covered: `caratula.test.ts`)

### Requirement: Normalisation Precedes Plate Validation
Plate input MUST be trimmed and upper-cased before the format regex is
applied, so a correctly-read plate in lowercase or with stray whitespace
validates rather than failing.

#### Scenario: Lowercase, whitespace-padded plate is accepted
- GIVEN `"  abc123  "`
- WHEN parsed against `colombianPlateSchema`
- THEN validation succeeds and the parsed value is the normalised uppercase plate
(Covered: `primitives.test.ts` — "normalises a lowercase plate to uppercase before validating", "trims stray whitespace before validating", "normalises a mixed-case, whitespace-padded plate to the uppercase value". RED/GREEN confirmed: temporarily removing `.trim().toUpperCase()` from `colombianPlateSchema` fails all 3 tests; restoring it passes all 3.)

### Requirement: Fields With No Destination Column Are Excluded
`tarjeta_propiedad` (make, model, year, engine number, chassis number) and
`cedula` (date/place of birth) fields with no `packages/db` column MUST NOT
appear in the schema.

#### Scenario: Extra printed fields are absent from the schema, not silently accepted
- GIVEN an object containing `make`, `model`, or `dateOfBirth` alongside valid fields
- WHEN parsed
- THEN the schema has no such field, and (per Zod's default behavior) the extra key is stripped from the parsed result, not rejected — `.success` is `true` and the returned object contains only known keys
(Covered: `caratula.test.ts`, `cedula.test.ts`, `tarjeta-propiedad.test.ts` — "silently strips an unknown key instead of rejecting the object". RED/GREEN confirmed: temporarily adding `.strict()` to all three schemas fails all 3 tests; removing it restores all 3 to passing, locking in the current stripping behavior as intentional, not incidental.)

#### Open Decision: `.strict()` is deliberately NOT used here — deferred to B2 (`ingestion-agent`)
This package intentionally does not call `.strict()` on any of the three
schemas, and this is a decision, not an oversight. An LLM producer's output
keys are not stable: if the model returns `plateNumber` instead of `plate`,
non-strict Zod silently strips the unknown key, the field reads as absent,
and — because every field is optional — the object still parses
successfully. The extraction *looks* successful while the value is
actually missing. `.strict()` trades that failure mode for a different one:
a harmless extra key (e.g. `_reasoning`, `confidence`) would fail the whole
parse and trigger the same Flash → Pro escalation this package exists to
avoid.

Neither default is correct at the schema-validation layer. The correct
owner of this tradeoff is B2 (`ingestion-agent`): it should compare the
returned key set against the expected key set and route a mismatch to
`needs_review`, which is exactly the mechanism `needs_review` exists for.
This is recorded here as an explicit open decision for B2 to resolve, not
as a gap in this capability's scope.

### Requirement: Scope Exclusions
This capability MUST NOT include model calls, confidence-threshold or
`needs_review` logic, DB writes/migrations, or a `factura` schema.

#### Scenario: Package has zero workspace dependencies
- GIVEN `packages/schemas/package.json`
- WHEN inspected
- THEN it depends only on `zod` (plain npm dependency), never `workspace:*`
(Covered: `packages/config/test/dependency-rule.test.ts`)
