# Webhook Ingress Specification

## Purpose

Define the behaviour of the inbound WhatsApp webhook path: authentication,
tenant resolution, idempotent persistence of messages (with the
`contacts`/`conversations` upsert steps the schema forces), multi-tenant
isolation, and the fixed echo reply. This is the first live ingress into the
F1 schema; every downstream agent (A2, B2, B3) depends on rows landing here
correctly.

## Requirements

### Requirement: Inbound Webhook Authentication

The system MUST refuse an unauthenticated inbound webhook request. No row is
written to any table for an unauthenticated request, and no tenant is
inferred or contacted for a lookup.

**NEEDS CONFIRMATION**: whether Chatwoot signs its outbound webhooks (e.g.
HMAC over the payload) or only supports a shared-secret mechanism (custom
header, bearer token, or URL token) is unverified — no live Chatwoot instance
or fixture exists yet. This requirement specifies the *outcome* (unauthenticated
requests are refused); the exact mechanism is `sdd-design`'s call (proposal O3).

#### Scenario: Request without valid authentication is rejected

- GIVEN a webhook POST to the Chatwoot ingress route that omits (or carries
  an invalid) authentication credential
- WHEN the request is processed
- THEN the response is a non-2xx status, no `messages`, `conversations`, or
  `contacts` row is written, and no tenant-resolution lookup runs

#### Scenario: Request with valid authentication is processed

- GIVEN a webhook POST carrying a valid authentication credential and a
  well-formed payload for a known `wa_phone_number_id`
- WHEN the request is processed
- THEN it proceeds to tenant resolution and persistence

### Requirement: Tenant Resolution by wa_phone_number_id

The system MUST resolve the owning `broker_id` from the payload's
`wa_phone_number_id` before any tenant-scoped database operation runs. The
resolution mechanism itself is a design decision (proposal O1/R1); this
requirement constrains only its observable behaviour.

#### Scenario: Known wa_phone_number_id resolves to its broker

- GIVEN a broker row exists with `wa_phone_number_id = 'X'`
- WHEN a webhook payload naming `wa_phone_number_id = 'X'` is processed
- THEN the message is persisted with `broker_id` equal to that broker's `id`

#### Scenario: Unknown wa_phone_number_id is refused, not guessed

- GIVEN no broker row has `wa_phone_number_id = 'Y'`
- WHEN a webhook payload naming `wa_phone_number_id = 'Y'` is processed
- THEN the request is rejected, no `messages`, `conversations`, or `contacts`
  row is written, and no `broker_id` is inferred or defaulted

#### Scenario: Unknown wa_phone_number_id emits an operational log without message content

- GIVEN no broker row has `wa_phone_number_id = 'Y'`
- WHEN a webhook payload naming `wa_phone_number_id = 'Y'` is processed and
  rejected
- THEN an operational log line is emitted recording that resolution failed
  for `wa_phone_number_id = 'Y'`, and that log line does not contain the
  message body, sender name, or any other field from the webhook payload
  beyond the `wa_phone_number_id` itself

### Requirement: Idempotent Message Persistence by wa_message_id

The system MUST persist each distinct `wa_message_id` exactly once,
regardless of how many times or how closely together it is delivered.
Deduplication MUST be enforced at the database constraint level (the
`messages.wa_message_id UNIQUE` constraint), not by an application-level
read-then-insert check, because a read-then-check-then-insert sequence is not
safe under concurrent delivery.

#### Scenario: Sequential replay of the same wa_message_id leaves one row

- GIVEN a webhook payload with `wa_message_id = 'wamid.A'` has already been
  processed and persisted
- WHEN a second webhook POST is delivered later, carrying the identical
  `wa_message_id = 'wamid.A'`
- THEN exactly one `messages` row exists with `wa_message_id = 'wamid.A'`
  after the second request, and the second request returns a 2xx response

#### Scenario: Concurrent delivery of the same wa_message_id leaves one row

- GIVEN a broker and conversation exist, and no `messages` row yet has
  `wa_message_id = 'wamid.B'`
- WHEN two webhook requests carrying the identical `wa_message_id =
  'wamid.B'` are issued concurrently (dispatched without waiting for either
  to complete before sending the other)
- THEN exactly one `messages` row exists with `wa_message_id = 'wamid.B'`
  after both requests complete, and both requests return a 2xx response

### Requirement: Contact Find-or-Create

The system MUST resolve a `contacts` row for the sending phone number within
the resolved broker's tenant scope, creating one if none exists, before the
message insert. Lookup and creation MUST key on `(broker_id, phone)`, matching
the `contacts` `UNIQUE (broker_id, phone)` constraint.

#### Scenario: First message from a new sender creates a contact

- GIVEN no `contacts` row exists for `(broker_id = B, phone = P)`
- WHEN a webhook message from phone `P` addressed to broker `B`'s number is
  processed
- THEN a `contacts` row is created with `broker_id = B`, `phone = P`, and the
  persisted `messages` row references that contact

#### Scenario: Subsequent message from a known sender reuses the existing contact

- GIVEN a `contacts` row already exists for `(broker_id = B, phone = P)`
- WHEN a second, distinct webhook message from phone `P` addressed to broker
  `B`'s number is processed
- THEN no second `contacts` row is created for `(broker_id = B, phone = P)`,
  and the new `messages` row references the existing contact

### Requirement: Conversation Find-or-Create

The system MUST resolve a `conversations` row linking the resolved broker and
contact, creating one if none exists, before the message insert, because
`messages.conversation_id` is `NOT NULL`. This MUST hold correctly under
concurrent first-contact delivery (two simultaneous first messages from the
same new sender must not create two `conversations` rows for that contact).
`conversations` currently has no UNIQUE constraint usable for `ON CONFLICT`;
the mechanism that guarantees this outcome (e.g. an added constraint, or
in-transaction serialization) is a design decision.

#### Scenario: First message in a thread creates a conversation

- GIVEN no `conversations` row exists linking broker `B` and contact `C`
- WHEN a webhook message from `C`'s phone number, addressed to `B`'s number,
  is processed
- THEN a `conversations` row is created with `broker_id = B` and
  `contact_id = C`, and the persisted `messages` row references that
  conversation

#### Scenario: Subsequent message in the same thread reuses the existing conversation

- GIVEN a `conversations` row already links broker `B` and contact `C`
- WHEN a second, distinct webhook message from `C`'s phone number, addressed
  to `B`'s number, is processed
- THEN no second `conversations` row is created for `(broker_id = B,
  contact_id = C)`, and the new `messages` row references the existing
  conversation

#### Scenario: Concurrent first messages from the same new contact do not duplicate the conversation

- GIVEN no `conversations` row yet exists linking broker `B` and contact `C`
  (a brand-new sender)
- WHEN two distinct webhook messages from `C`'s phone number, addressed to
  `B`'s number, are delivered concurrently
- THEN exactly one `conversations` row exists linking `(broker_id = B,
  contact_id = C)` after both requests complete, and both `messages` rows
  reference that single conversation

### Requirement: Multi-Tenant Isolation

The system MUST guarantee that data belonging to one broker is never
readable through a session scoped to a different broker. This is a
non-negotiable requirement (ROADMAP hard requirement); a passing test using
the existing live-test conventions (`describe.skipIf(LIVE_TEST_DATABASE_URL)`,
throwaway schema, disposable fixture roles, `assertThrowawayDatabase`) is
required before this change is considered applied.

#### Scenario: Broker X cannot read Broker Y's messages, conversations, or contacts

- GIVEN broker X and broker Y each have at least one row in `messages`,
  `conversations`, and `contacts`, created via the webhook ingress path
- WHEN a query scoped to broker X's tenant context reads `messages`,
  `conversations`, or `contacts`
- THEN only rows belonging to broker X are returned; none of broker Y's rows
  appear in any of the three tables

#### Scenario: The tenant-resolution mechanism does not expose arbitrary brokers rows

- GIVEN the application role (`dirus_app`, or whichever role the deployed
  service authenticates as) has no tenant context set
- WHEN that role performs any read of `brokers` other than through the
  sanctioned tenant-resolution path (e.g. a direct `SELECT * FROM brokers`)
- THEN zero rows are returned — the mechanism that resolves
  `wa_phone_number_id → broker_id` MUST NOT be achieved by a policy or grant
  that makes `brokers` rows readable to the application role in general

### Requirement: Fixed Echo Reply

The system MUST reply to a successfully processed inbound message with a
fixed Spanish acknowledgement, not a reproduction of the customer's own
message text. The reply copy is a placeholder pending the real agent
(A2/B2) and MUST NOT promise a specific resolution or timeframe beyond
acknowledging receipt.

#### Scenario: Reply is a fixed acknowledgement, not the customer's text

- GIVEN a webhook message with body text `"Hola, necesito una cotización"` is
  successfully processed
- WHEN the echo reply is sent back through Chatwoot
- THEN the reply text is the fixed acknowledgement copy, and it is not equal
  to `"Hola, necesito una cotización"` or any substring-derived echo of it

#### Scenario: Reply is not sent when persistence fails

- GIVEN a webhook message fails to persist (e.g. rejected before the
  transaction commits)
- WHEN the request handling completes
- THEN no echo reply is sent through Chatwoot for that message

### Requirement: Media Message Persistence

The system MUST persist a media message (image, audio, document, etc.) with
a null `media_r2_key`. Downloading the media to R2 is out of scope for this
change; the row is still created so a later change can retrieve it.

#### Scenario: Media message is persisted with a null media_r2_key

- GIVEN a webhook payload representing a media message (e.g. an image) for a
  known `wa_phone_number_id`
- WHEN the message is processed
- THEN a `messages` row is created with the available metadata and
  `media_r2_key` is `NULL`, and no attempt is made to fetch or store the
  media binary

### Requirement: Raw Payload Is Not Retained Verbatim

The system MUST NOT persist the raw inbound Chatwoot webhook payload
verbatim. Only the fields modeled by the Chatwoot webhook payload schema
(`packages/schemas`) are extracted and persisted.

#### Scenario: Only schema-modeled fields reach persistence

- GIVEN a webhook payload containing fields beyond what the Chatwoot payload
  Zod schema models (e.g. additional Chatwoot-internal metadata)
- WHEN the message is processed and persisted
- THEN no column or row in the database contains the full, unparsed raw
  payload; only the schema-modeled fields are present in the persisted data
