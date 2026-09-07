# Product Metrics Specification

## Purpose

Define the six §12 (`docs/ARCHITECTURE.md`) product metrics as live-queried
read endpoints, each backed by a real query against existing columns rather
than a hand-maintained or cached number (issue #19's acceptance criterion),
with correct behavior against both empty tables (since A2/B2 have not
landed) and seeded fixture data.

## Requirements

### Requirement: Six Endpoints Exist, One Per §12 Metric

The system MUST expose one read endpoint per §12 metric, scoped to the
authenticated broker (never a client-supplied `brokerId`):

1. Copilot usage (`conversations.kind = 'copilot'` volume)
2. Renewal funnel (`renewals GROUP BY status`)
3. Extraction review load (`extractions.needs_review` count/rate)
4. Conversation resolution snapshot (`conversations.status` distribution — current-state, see below)
5. Time-to-first-renewal-contact (`messages.type = 'template'` + `brokers.created_at`)
6. Cost per conversation/renewal (Langfuse-sourced)

#### Scenario: Each metric has a distinct, callable endpoint

- GIVEN an authenticated session for a broker with a `broker_users` row
- WHEN each of the six metric endpoints is called
- THEN each returns a 2xx response with a result shaped for its own metric,
  scoped to that session's `broker_id`

### Requirement: Each Metric Is Backed By a Live Query, Not a Hardcoded Value

Each of the six metrics (or, for cost, its non-deferred parts) MUST be
computed by a real query against current table state at request time. The
value returned MUST change when the underlying data changes, without any
code or configuration change — proving the endpoint is not a cached or
hardcoded stub.

#### Scenario: The renewal-funnel metric changes when a renewal's status changes

- GIVEN the renewal-funnel endpoint returns a count of `N` renewals with
  `status = 'paid'` for broker B
- WHEN a new `renewals` row for broker B is inserted with `status = 'paid'`
  and the endpoint is called again
- THEN the returned count for `status = 'paid'` is `N + 1`, without any
  code or configuration change between the two calls

#### Scenario: The copilot-usage metric changes when a copilot conversation is added

- GIVEN the copilot-usage endpoint returns a count of `M` for broker B
- WHEN a new `conversations` row with `kind = 'copilot'` is inserted for
  broker B and the endpoint is called again
- THEN the returned count is `M + 1`

### Requirement: Metrics Return Correct Empty-State Results

Each metric endpoint MUST return a well-formed, explicit empty-state result
(not an error, not `null`, not an undefined shape) when its underlying
table(s) contain zero rows for the caller's broker, and that empty-state
result MUST be distinguishable from a legitimate zero count arrived at from
non-empty data.

#### Scenario: An endpoint against an empty table returns a valid empty-state shape

- GIVEN broker B has zero rows in `renewals`
- WHEN the renewal-funnel endpoint is called for broker B
- THEN the response is a 2xx with a result object marked as empty-state
  (e.g. an explicit `hasData: false` or equivalent), not an error and not a
  bare `0`/`null` indistinguishable from a real zero

#### Scenario: An endpoint against seeded non-empty data returns real counts

- GIVEN broker B has seeded fixture `renewals` rows across multiple
  `status` values
- WHEN the renewal-funnel endpoint is called for broker B
- THEN the response reflects the actual per-status counts from the seeded
  rows, marked as having data

### Requirement: "Resolved Without Human" Panel Is Labeled a Current-State Snapshot

Per proposal Product Decisions P8/O8, the conversation-resolution metric
MUST be computed from `conversations.status`'s current value, not from a
transition history (no such table exists). The endpoint's response MUST
carry an explicit marker (e.g. a `snapshotType: "current-state"` field or
equivalent) indicating this is not the true §12 at-close measurement, and
any UI-facing label consuming it MUST NOT claim it is the at-close metric.

#### Scenario: The endpoint's response is marked as a snapshot, not an at-close measurement

- GIVEN broker B has `conversations` rows in various `status` values
- WHEN the conversation-resolution endpoint is called
- THEN the response includes an explicit field identifying the result as a
  current-state snapshot, distinct from an "at close" measurement

#### Scenario: A conversation escalated then later closed is indistinguishable from one that never involved a human

- GIVEN two `conversations` rows for broker B both currently have
  `status = 'resolved'`, one of which was previously escalated and one of
  which never was (no transition history exists to tell them apart)
- WHEN the conversation-resolution endpoint is called
- THEN both rows are counted identically under their current `status`, and
  the response does not claim to distinguish "resolved after escalation"
  from "resolved without human" — consistent with its current-state-only
  scope

### Requirement: Cost Metric Discloses Deferred State

Per proposal P6, the cost-per-conversation/renewal metric depends on a
Langfuse API integration not yet built. The endpoint MUST exist but MAY
return an explicit deferred/unavailable state rather than a computed value.
It MUST NOT silently return a fabricated or zero value that could be
mistaken for a real measurement.

#### Scenario: The cost endpoint discloses deferred state rather than fabricating a number

- GIVEN the Langfuse integration is not implemented
- WHEN the cost metric endpoint is called
- THEN the response explicitly marks the metric as unavailable/deferred
  (e.g. `status: "deferred"` or equivalent), and does not return a
  plausible-looking numeric value in its place

### Requirement: Metrics Are Scoped to the Authenticated Broker

No metric endpoint MUST accept a `brokerId` parameter from the client;
`broker_id` MUST be resolved from the authenticated session, and results
MUST reflect only that broker's data.

#### Scenario: Broker A's metrics never include Broker B's rows

- GIVEN broker A and broker B each have distinct `renewals`, `conversations`,
  and `extractions` rows
- WHEN any metric endpoint is called for an authenticated session belonging
  to broker A
- THEN every value in the response is computed from broker A's rows only
