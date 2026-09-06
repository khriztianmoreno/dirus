# Policy Import Specification

## Purpose

Define the behaviour of `POST /admin/policies/import`: caller authentication,
required request shape, per-row validation and reporting, contact
find-or-create with fill-blanks-only semantics, idempotent policy upsert, the
documented non-idempotency of unnumbered rows, the Habeas Data consent
invariant, and RLS scoping. This is a new capability (F1/F2 schema exists;
no ingestion path into `policies` exists yet).

## Requirements

### Requirement: Admin Token Authentication

The system MUST refuse a request to `/admin/policies/import` that lacks a
valid admin token, comparing it with a constant-time comparison
(`crypto.timingSafeEqual`). No row is written to any table for an
unauthenticated request.

**Resolved (proposal Product Decisions — Round 2, O6)**: the header is
`X-Dirus-Admin-Token`, matching `X-Dirus-Webhook-Token`'s naming exactly —
one convention for this project's own shared-secret headers, kept distinct
from `Authorization: Bearer`, which other callers may expect to carry real
credentials.

#### Scenario: Request without a valid admin token is rejected with 401 and writes nothing

- GIVEN a multipart request to `/admin/policies/import` with a missing or
  incorrect admin token
- WHEN the request is processed
- THEN the response status is 401 with an empty body, and no `contacts` or
  `policies` row exists afterward that did not exist before the request

#### Scenario: Request with a valid admin token proceeds to parsing

- GIVEN a multipart request carrying the correct admin token, a valid
  `brokerId`, and a well-formed file
- WHEN the request is processed
- THEN it proceeds to file parsing and row processing

### Requirement: Multipart Request Shape

The system MUST require a `brokerId` form field and a `file` field (CSV or
XLSX) in the same multipart body. `brokerId` MUST NOT be inferred from the
admin token.

#### Scenario: Missing brokerId is rejected as a file-level error

- GIVEN a multipart request with a file field but no `brokerId` field
- WHEN the request is processed
- THEN the response is a 4xx status naming the missing `brokerId`, and no
  `contacts` or `policies` row is written

#### Scenario: Unknown brokerId is rejected before any row is processed

- GIVEN a multipart request with a `brokerId` that does not match any
  existing `brokers.id`
- WHEN the request is processed
- THEN the response status is 404, no `contacts` or `policies` row is
  written, and a single structured log line
  (`policy_import_unknown_broker`, `{ brokerId }`) is emitted containing
  only the `brokerId` — never file content or row data

**Resolved (proposal Product Decisions — Round 2, O3)**: 404, not 401. The
admin token authenticates "this caller may import for some broker"; it does
not vouch for which one, so an unknown `brokerId` is the caller's error, not
an authentication failure — the same reasoning F2's tenant-resolution-miss
(P4) already established for this codebase. The token holder is already a
trusted administrative caller, not an anonymous attacker, so confirming
broker-id existence to them is an accepted, not a leaked, fact.

### Requirement: Request Size Is Bounded Before Parsing Begins

The system MUST reject a request whose file exceeds 5 MB, or whose row
count exceeds 5,000, before parsing any row. This is the one whole-file
rejection in this change — a request too large to process safely inside a
synchronous handler is not a partial-file scenario, unlike a validation
failure on individual rows.

**Resolved (proposal Product Decisions — Round 2, O2)**: no real broker file
exists to calibrate against; 5 MB / 5,000 rows is a conservative starting
limit chosen to keep a synchronous request inside a typical platform HTTP
timeout, not a measured number. It is a guard at the top of the handler, not
encoded in the schema or the migration, so raising it later touches one
place.

#### Scenario: A file exceeding the size limit is rejected before parsing

- GIVEN a multipart request whose `file` field is larger than 5 MB
- WHEN the request is processed
- THEN the response is a 4xx status naming the size limit, no row is
  parsed, and no `contacts` or `policies` row is written

#### Scenario: A file exceeding the row-count limit is rejected before any row is upserted

- GIVEN a well-formed file with 5,001 data rows
- WHEN the request is processed
- THEN the response is a 4xx status naming the row-count limit, and no
  `contacts` or `policies` row is written for any row in the file

### Requirement: Row Validation Is Per-Row, Not Whole-File

The system MUST validate each parsed row independently against a Zod schema
in `packages/schemas`. A validation failure on one row MUST NOT prevent any
other row in the same file from being processed.

#### Scenario: One malformed row does not fail the file

- GIVEN a file with 5 rows where row 4 has an invalid `end_date` and rows
  1-3 and 5 are valid
- WHEN the file is imported
- THEN the response `totals.rows` is 5, `totals.failed` is 1, the row-4
  entry has `status: "failed"` with an `errors` array naming the `end_date`
  field, and rows 1, 2, 3, and 5 each have `status` of `"inserted"` or
  `"updated"` with a `policyId` and `contactId` present

#### Scenario: A file missing a required header is rejected wholesale

- GIVEN a file whose header row omits a required column (e.g. `end_date`)
- WHEN the file is imported
- THEN the response is a 4xx status naming the missing header, and no
  `contacts` or `policies` row is written for any row in the file

**NEEDS CONFIRMATION (O1)**: the full required/optional column set beyond
`insurer`, `line`, `end_date`, and a contact phone (all `NOT NULL` in the
schema, therefore required) is unconfirmed pending a real broker file.

### Requirement: Contact Find-or-Create Fills Blanks Only

The system MUST resolve a `contacts` row by `(broker_id, phone)`, creating
one if none exists. On an existing contact, the import MUST NOT overwrite a
non-null `full_name`, `doc_type`, or `doc_number` with a spreadsheet value —
each such column is updated only when the existing column value is currently
NULL.

#### Scenario: A blank spreadsheet field does not erase existing contact data

- GIVEN a `contacts` row exists for `(broker_id = B, phone = P)` with
  `full_name = "Ana Ruiz"` (set previously via F2 ingress)
- WHEN a row for phone `P` under broker `B` is imported with an empty
  `full_name` cell
- THEN `contacts.full_name` for that row remains `"Ana Ruiz"` after the
  import

#### Scenario: A differing spreadsheet field does not overwrite existing contact data

- GIVEN a `contacts` row exists for `(broker_id = B, phone = P)` with
  `full_name = "Ana Ruiz"`
- WHEN a row for phone `P` under broker `B` is imported with
  `full_name = "Ana R."`
- THEN `contacts.full_name` for that row remains `"Ana Ruiz"` after the
  import (spreadsheet value is discarded, not merged)

#### Scenario: A previously-null field is filled from the spreadsheet

- GIVEN a `contacts` row exists for `(broker_id = B, phone = P)` with
  `doc_number IS NULL`
- WHEN a row for phone `P` under broker `B` is imported with
  `doc_number = "123456"`
- THEN `contacts.doc_number` for that row equals `"123456"` after the import

### Requirement: Import Never Writes contacts.consent_at

The system MUST NOT include `consent_at` in any `INSERT` or `UPDATE` column
list issued by the import path, regardless of the source file's contents.

#### Scenario: A file with an adversarial consent-looking column leaves consent_at NULL

- GIVEN a file whose header row includes a column literally named
  `consent` (or `acepta_terminos`) containing the value `true` or a plausible
  date, for a row that creates a new contact and for a row that updates an
  existing contact with `consent_at IS NULL`
- WHEN the file is imported
- THEN every `contacts` row touched by the import (both newly created and
  updated) has `consent_at IS NULL` afterward, and the SQL/query issued by
  the import path contains no reference to `consent_at` in its column list

### Requirement: Idempotent Policy Upsert Keyed on (broker_id, policy_number)

For a row carrying a non-null `policy_number`, the system MUST upsert
`policies` keyed on `(broker_id, policy_number)`: insert if no matching row
exists, update the matching row's fields otherwise. Re-importing the same
file with edited values MUST update the matching rows and insert no new
rows.

#### Scenario: Re-importing an unedited file changes nothing and inserts nothing

- GIVEN a file was already imported successfully, creating N `policies` rows
  each with a `policy_number`
- WHEN the identical file is imported again
- THEN `totals.inserted` is 0, `totals.updated` is N, and the total
  `policies` row count for that broker is unchanged before and after

#### Scenario: Re-importing an edited file updates matching rows without duplication

- GIVEN a policy row exists with `(broker_id = B, policy_number = "POL-1")`
  and `end_date = "2026-01-01"`
- WHEN a file is imported for broker `B` containing `policy_number = "POL-1"`
  with `end_date = "2027-01-01"`
- THEN exactly one `policies` row exists for `(broker_id = B,
  policy_number = "POL-1")` afterward, and its `end_date` is `"2027-01-01"`

#### Scenario: A row whose policy_number matches but whose phone maps to a different contact fails the row

- GIVEN a policy row exists with `(broker_id = B, policy_number = "POL-2")`
  linked to `contact_id = C1`
- WHEN a file is imported for broker `B` containing `policy_number = "POL-2"`
  with a phone that resolves to a different, existing contact `C2`
- THEN the row's `status` is `"failed"` with an error naming the
  `policy_number`/contact mismatch, the existing `policies` row for
  `POL-2` still references `contact_id = C1` unchanged, and no other row in
  the file is affected

**Resolved (proposal Product Decisions — Round 2, O5)**: fail-the-row is
final, not tentative. Silently repointing a policy at a different customer
because a spreadsheet's phone column was mistyped is a data-integrity
incident; a rejected row the broker can see and fix on re-upload is not.

### Requirement: Rows Without policy_number Are Honestly Non-Idempotent

A row with no `policy_number` MUST always insert a new `policies` row — it
MUST NOT be matched against any existing row. The per-row response for such
a row MUST include a warning stating the row is not idempotent.

#### Scenario: An unnumbered row always inserts, never matches an existing row

- GIVEN a file contains one row with no `policy_number` value for broker `B`
- WHEN the file is imported
- THEN a new `policies` row is inserted with `policy_number IS NULL`, and
  the row's response entry has `status: "inserted"` with a `warnings` array
  containing a message about non-idempotency

#### Scenario: Re-importing a file with an unnumbered row creates a duplicate

- GIVEN the file from the prior scenario has already been imported once,
  creating one `policies` row with `policy_number IS NULL` for contact `C`
- WHEN the identical file is imported again
- THEN a second, distinct `policies` row is created with `policy_number IS
  NULL` for the same contact `C` (two rows total), and both import
  responses flag that row with the non-idempotency warning

### Requirement: Import Never Deletes or Reconciles Absent Policies

A `policies` row not present in a re-imported file MUST be left untouched —
never soft-deleted, never marked cancelled, never modified in any way by its
absence from the file.

#### Scenario: A policy absent from a re-imported file is untouched

- GIVEN broker `B` has two existing `policies` rows, `POL-1` and `POL-2`
- WHEN a file containing only `POL-1` (with edits) is imported for broker
  `B`
- THEN `POL-1` is updated per the file, and `POL-2`'s `status`, `end_date`,
  and every other column remain exactly as they were before the import

### Requirement: Response Reports Per-Row Outcome and File-Level Totals

The response MUST report, for the whole file: total row count and counts of
inserted/updated/failed rows; and, for each row: its 1-based row number,
`status` (`inserted`/`updated`/`failed`), and on success the resulting
`policyId`/`contactId`, or on failure a list of field-level errors. The
response MUST be returned with HTTP 200 whenever the file itself was
processed (`failed > 0` at the row level does not change the file-level
status code); only file-level rejections (auth, unknown broker, unparseable
file, missing required headers) use a 4xx status.

#### Scenario: A file with mixed outcomes returns 200 with a full per-row report

- GIVEN a file with 3 valid rows and 1 invalid row
- WHEN the file is imported
- THEN the response status is 200, `totals.rows` is 4, `totals.failed` is 1,
  and the `rows` array contains exactly 4 entries, each carrying a 1-based
  `row` number matching its position in the source file

### Requirement: Import Runs Within withBrokerContext and Respects RLS

Every write performed by the import path MUST run inside
`withBrokerContext(brokerId, …)` from `@dirus/db`, scoped to the `brokerId`
supplied in the request.

#### Scenario: Imported rows are visible only under the importing broker's context

- GIVEN broker A imports a file creating `contacts` and `policies` rows
- WHEN a query scoped to broker B's `withBrokerContext` reads `contacts` or
  `policies`
- THEN none of broker A's newly imported rows appear
