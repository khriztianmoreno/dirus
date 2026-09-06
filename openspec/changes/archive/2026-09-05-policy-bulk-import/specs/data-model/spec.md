# Delta for Data Model

## ADDED Requirements

### Requirement: Partial Unique Index on Numbered Policies

The system MUST enforce a **partial** unique index,
`CREATE UNIQUE INDEX … ON policies (broker_id, policy_number) WHERE
policy_number IS NOT NULL`, defining "the same policy" as a `(broker_id,
policy_number)` pair only when `policy_number` is present. This index is
required, as a distinct constraint shape, for the following reasons — a
future edit that "simplifies" it away MUST be treated as a regression, not a
cleanup:

- A plain `UNIQUE (broker_id, policy_number)` (no `WHERE` clause) would
  *appear* identical in every test that always supplies a `policy_number`,
  because Postgres treats each `NULL` as distinct from every other `NULL` in
  a standard unique index — rows with `policy_number IS NULL` would
  silently accumulate without violating it. The constraint would pass by
  accident, not by design, and would misdescribe its own intent to a reader.
- `NULLS NOT DISTINCT` (PG15+) is actively destructive here: it would
  collapse every `policy_number IS NULL` row for a given broker into a
  single row, since it treats all NULLs in the indexed columns as equal —
  destroying distinct real policies that happen to lack a policy number.
- The partial index is the only shape whose semantics match the actual
  rule: numbered policies participate in idempotency; unnumbered ones do
  not, and multiple unnumbered rows for the same broker are legitimate,
  distinct policies.

#### Scenario: Two policies with the same policy_number for the same broker are rejected

- GIVEN a `policies` row exists with `(broker_id = B, policy_number =
  "POL-1")`
- WHEN a second `INSERT` attempts `(broker_id = B, policy_number =
  "POL-1")`
- THEN the database rejects it with a unique-violation error, and only one
  row exists afterward for that pair

#### Scenario: Multiple policies with a NULL policy_number for the same broker are permitted

- GIVEN a `policies` row exists with `(broker_id = B, policy_number =
  NULL)`
- WHEN a second `INSERT` attempts `(broker_id = B, policy_number = NULL)`
- THEN the insert succeeds, and two distinct `policies` rows exist for
  broker `B` with `policy_number IS NULL`

#### Scenario: The same policy_number is permitted across different brokers

- GIVEN a `policies` row exists with `(broker_id = A, policy_number =
  "POL-9")`
- WHEN an `INSERT` attempts `(broker_id = B, policy_number = "POL-9")` for
  a different broker `B`
- THEN the insert succeeds, and one row exists for each broker with
  `policy_number = "POL-9"`

#### Scenario: The committed migration SQL encodes a partial index, not a plain or NULLS-NOT-DISTINCT one

- GIVEN the committed migration SQL adding this index
- WHEN inspected
- THEN it contains a `WHERE policy_number IS NOT NULL` clause verbatim, and
  contains no `NULLS NOT DISTINCT` clause
