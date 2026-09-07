# Delta for Webhook Ingress

Supersedes the requirement "Tenant Resolution by wa_phone_number_id"
(`openspec/specs/webhook-ingress/spec.md:41-69`), which specified a
resolution mechanism that cannot work against a real Chatwoot payload
(`inbox` carries no `phone_number` field). Per proposal P4, this delta
REPLACES that requirement's content at archive time; it does not sit
alongside it.

## RENAMED Requirements

### Requirement: Tenant Resolution by wa_phone_number_id → Tenant Resolution by account.id

(Reason: the resolution key changed from a nonexistent payload field,
`inbox.phone_number`, to `account.id`, matched against
`brokers.chatwoot_account_id`. `wa_phone_number_id` was never reachable in a
real Chatwoot payload; this is a correction, not a preference.)
(Migration: any reference to `wa_phone_number_id` as the webhook-ingress
resolution key — in code, tests, or docs — must be updated to `account.id` /
`chatwoot_account_id`. `brokers.wa_phone_number_id` remains as a mirror
column; it is no longer read by this path.)

## MODIFIED Requirements

### Requirement: Tenant Resolution by account.id

The system MUST resolve the owning `broker_id` from the payload's
`account.id` (an integer) before any tenant-scoped database operation runs,
matched against `brokers.chatwoot_account_id`. The resolution mechanism
itself is a design decision (proposal P3/O1); this requirement constrains
only its observable behaviour.
(Previously: resolved on `payload.inbox.phone_number` against
`brokers.wa_phone_number_id` — a field that does not exist in a real
Chatwoot payload.)

`extractResolutionKey()` MUST return `number | null`: the numeric
`account.id` when present and well-formed, and `null` — never a thrown
error — when `account.id` is absent or malformed.

The boundary MUST reject a non-integer, non-positive, or out-of-`int4`-range
`account.id` before any database query runs. This is a clean refusal, not a
500: a Postgres numeric-overflow or type error surfacing to the caller is a
defect, not an acceptable failure mode.

#### Scenario: Known account.id resolves to its broker

- GIVEN a broker row exists with `chatwoot_account_id = 42`
- WHEN a webhook payload naming `account.id = 42` is processed
- THEN the message is persisted with `broker_id` equal to that broker's `id`

#### Scenario: Unknown account.id is refused, not guessed

- GIVEN no broker row has `chatwoot_account_id = 999`
- WHEN a webhook payload naming `account.id = 999` is processed
- THEN the request is rejected, no `messages`, `conversations`, or
  `contacts` row is written, and no `broker_id` is inferred or defaulted

#### Scenario: Unknown account.id emits an operational log without message content

- GIVEN no broker row has `chatwoot_account_id = 999`
- WHEN a webhook payload naming `account.id = 999` is processed and rejected
- THEN an operational log line is emitted recording that resolution failed
  for `account.id = 999`, and that log line does not contain the message
  body, sender name, or any other field from the webhook payload beyond
  `account.id` itself

#### Scenario: extractResolutionKey returns a number for a well-formed payload

- GIVEN a real Chatwoot `message_created` payload with `account.id = 42`
- WHEN `extractResolutionKey()` is called with that payload
- THEN it returns the number `42`

#### Scenario: extractResolutionKey returns null, never throws, when account.id is absent or malformed

- GIVEN a payload where `account` is missing, or `account.id` is missing,
  `null`, a string, or otherwise not a well-formed integer
- WHEN `extractResolutionKey()` is called with that payload
- THEN it returns `null` and does not throw

#### Scenario: A non-integer, negative, or out-of-int4-range account.id is refused before any query runs

- GIVEN a resolution key of `"abc"`, `-1`, `1.5`, or `9999999999` (exceeding
  Postgres `int4` range)
- WHEN tenant resolution is attempted with that key
- THEN the request is refused with a clean, non-500 rejection, no database
  query is issued for that key, and no `broker_id` is inferred
