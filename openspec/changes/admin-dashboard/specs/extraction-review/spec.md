# Extraction Review Specification

## Purpose

Define the human review workflow for flagged extractions: listing rows where
`extractions.needs_review = true`, rendering the minimal per-field envelope
stub defined by this change (proposal P9), and writing back a reviewer's
correction so the flag clears. This gives `extractions.needs_review` and its
partial index their first reader.

## Requirements

### Requirement: Review Queue Lists Only Flagged Extractions

The system MUST provide an endpoint that lists `extractions` rows where
`needs_review = true`, scoped to the authenticated broker's `broker_id`
(never a client-supplied one). Rows with `needs_review = false` MUST NOT
appear in this list.

#### Scenario: Only flagged rows appear in the queue

- GIVEN broker B has three `extractions` rows: two with
  `needs_review = true` and one with `needs_review = false`
- WHEN the review queue endpoint is called for an authenticated session
  belonging to broker B
- THEN the response contains exactly the two rows with
  `needs_review = true`, and not the third

#### Scenario: The queue is scoped to the caller's own broker

- GIVEN broker A and broker B each have `extractions` rows with
  `needs_review = true`
- WHEN the review queue endpoint is called for a session belonging to
  broker A
- THEN only broker A's flagged rows are returned; none of broker B's rows
  appear

### Requirement: Per-Field Envelope Rendering

The system MUST render each listed extraction's `output`/`confidence` pair
through the minimal `Record<fieldName, { value: unknown; confidence: number }>`
envelope stub (proposal P9), exposing, for each field present in `output`,
its value and its confidence score, rather than the raw undifferentiated
JSON blob.

#### Scenario: Fields below 0.85 are individually visible

- GIVEN an `extractions` row whose `confidence` records `{ policyNumber: 0.92, endDate: 0.61 }`
  and whose `output` records matching values for those two fields
- WHEN that extraction is rendered through the review endpoint
- THEN the response exposes `endDate`'s value and its `0.61` confidence
  score as a distinct field-level entry, separately from `policyNumber`'s
  `0.92` entry — not as a single opaque JSON object

#### Scenario: An extraction shape the stub does not recognize does not crash the endpoint

- GIVEN an `extractions` row whose `output`/`confidence` JSON does not
  conform to the envelope stub's expected shape
- WHEN that extraction is rendered through the review endpoint
- THEN the endpoint returns a response (degrading to a raw-JSON
  representation for that row) rather than throwing an unhandled error

### Requirement: Reviewer Correction Writes Back correctedOutput and correctedBy

The system MUST accept a reviewer's correction for a flagged extraction and
persist it to `extractions.correctedOutput` (the corrected field values) and
`extractions.correctedBy` (the resolving `broker_user_id`, taken from the
session — never client-supplied).

#### Scenario: A correction persists both correctedOutput and correctedBy

- GIVEN a flagged `extractions` row with `correctedOutput IS NULL` and
  `correctedBy IS NULL`, and an authenticated session for broker user U
- WHEN U submits a correction for that row's `endDate` field
- THEN the row's `correctedOutput` reflects the corrected value and
  `correctedBy` equals U's `broker_user_id`

#### Scenario: correctedBy is taken from the session, not the request body

- GIVEN an authenticated session for broker user U, and a correction request
  whose body includes a `correctedBy` field naming a different broker user
- WHEN the correction is submitted
- THEN the persisted `correctedBy` equals U's `broker_user_id`, not the
  value supplied in the request body

### Requirement: Resolving a Correction Clears needs_review

The system MUST set `extractions.needs_review = false` when a reviewer's
correction for that row is successfully persisted. A resolved extraction
MUST NOT appear in a subsequent call to the review queue endpoint.

#### Scenario: A resolved extraction disappears from the queue

- GIVEN a flagged `extractions` row with `needs_review = true` for broker B
- WHEN a reviewer submits a correction for that row and it persists
  successfully
- THEN that row's `needs_review` is `false`, and a subsequent call to the
  review queue endpoint for broker B no longer includes it

#### Scenario: A failed correction attempt leaves needs_review unchanged

- GIVEN a flagged `extractions` row with `needs_review = true`
- WHEN a correction submission fails validation (e.g. a field the schema
  requires is missing) and is rejected
- THEN `needs_review` remains `true` and `correctedOutput`/`correctedBy`
  remain unchanged from before the attempt

### Requirement: Extraction Confidence Threshold and Re-Ask Rule Apply Unchanged

Per project convention, any spec touching extraction MUST state the 0.85
confidence threshold and the re-ask-never-guess rule explicitly: a field
scoring below 0.85 confidence is why a row is flagged for `needs_review` in
the first place, and this capability's role is strictly to let a human
resolve that flag — it MUST NOT introduce any path that silently guesses or
auto-accepts a low-confidence field without a human-supplied correction.

#### Scenario: A low-confidence field is never auto-accepted without human input

- GIVEN a flagged extraction with a field below 0.85 confidence
- WHEN the row is processed by any part of this capability without an
  explicit reviewer-submitted correction for that field
- THEN `needsReview` remains `true` and `correctedOutput` for that field is
  not populated with a guessed or auto-filled value
