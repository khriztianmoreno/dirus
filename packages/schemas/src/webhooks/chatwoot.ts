import { z } from "zod";

/**
 * @provisional
 *
 * Chatwoot `message_created` webhook payload — two-stage parse (design D-6).
 *
 * **NEEDS CONFIRMATION** (proposal O4, design D-6, "Open and material"): no
 * live Chatwoot instance or captured payload backs this schema. It is
 * derived from Chatwoot's public webhook documentation
 * (https://www.chatwoot.com/docs/product/others/webhooks), not a real
 * payload. Two things are unverified and may be wrong:
 *
 * 1. The exact shape below (field names, nesting, optionality).
 * 2. Which field, if any, carries Meta's `wa_phone_number_id`. This schema's
 *    current best guess is `inbox.phone_number` (see `extractResolutionKey`
 *    below, the single isolated point of contact with that guess). If a
 *    real payload shows Chatwoot does not expose it at all, design D-6's
 *    stated fallback is `account.id` against `brokers.chatwoot_account_id`
 *    — a change confined to `extractResolutionKey` and the
 *    `dirus_resolve_broker_id` predicate, per the design.
 *
 * Do not remove this marker until a real captured payload replaces
 * `test/fixtures/chatwoot-message-created.json` (task 4.8, deliberately not
 * attempted until O4 is confirmed).
 *
 * Two stages, per design D-6:
 * - **Stage 1 — envelope** (`chatwootWebhookEnvelopeSchema`): non-strict,
 *   cheap. A caller parses only this shape to decide whether to discard the
 *   event (anything that is not `message_created` / `incoming`) before ever
 *   attempting the expensive stage-2 parse below.
 * - **Stage 2 — message payload** (`chatwootMessageCreatedPayloadSchema`):
 *   strict-by-omission. Zod's default behavior (no `.passthrough()`, which
 *   is forbidden here) strips any key not modeled below — this is the
 *   mechanism that satisfies spec "Raw Payload Is Not Retained Verbatim" /
 *   proposal P2. A malformed `message_created` payload fails this stage.
 */
export const chatwootWebhookEnvelopeSchema = z.object({
  event: z.string(),
  message_type: z.string().optional(),
});

export type ChatwootWebhookEnvelope = z.infer<typeof chatwootWebhookEnvelopeSchema>;

/**
 * Cheap stage-1 gate: `true` for anything the ingest pipeline should
 * discard with `200 { ignored: true }` before attempting a stage-2 parse.
 * Only `message_created` events whose `message_type` is `incoming` are not
 * ignorable.
 */
export function isIgnorableChatwootEvent(envelope: ChatwootWebhookEnvelope): boolean {
  return envelope.event !== "message_created" || envelope.message_type !== "incoming";
}

const chatwootSenderSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  phone_number: z.string().optional(),
});

const chatwootContactSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  phone_number: z.string().optional(),
});

const chatwootConversationSchema = z.object({
  id: z.number(),
});

const chatwootAccountSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
});

// @provisional: `phone_number` here is the unconfirmed best guess for
// carrying Meta's `wa_phone_number_id` — see the module docstring above.
// Required, not optional: `extractResolutionKey` promises a `string`
// return, never a silent empty-string fallback, so a payload missing this
// field fails stage-2 parsing loudly instead of resolving to no tenant.
const chatwootInboxSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  phone_number: z.string(),
});

export const chatwootMessageCreatedPayloadSchema = z.object({
  event: z.literal("message_created"),
  id: z.number(),
  content: z.string().nullable(),
  message_type: z.literal("incoming"),
  content_type: z.string(),
  source_id: z.string().nullable().optional(),
  sender: chatwootSenderSchema,
  contact: chatwootContactSchema,
  conversation: chatwootConversationSchema,
  account: chatwootAccountSchema,
  inbox: chatwootInboxSchema,
});

export type ChatwootMessageCreatedPayload = z.infer<typeof chatwootMessageCreatedPayloadSchema>;

/**
 * The single, deliberately isolated point of contact with "which field
 * carries the resolution key" (design D-6). Every caller that needs the key
 * for `resolveBrokerIdByWaPhoneNumberId` must go through this function —
 * never read `payload.inbox.phone_number` (or any other field) directly.
 * If the field turns out to be wrong once a real payload is captured
 * (O4), this function is the only place that changes.
 *
 * @provisional current best guess: `inbox.phone_number`. See the module
 * docstring for the stated fallback if this is wrong.
 */
export function extractResolutionKey(payload: ChatwootMessageCreatedPayload): string {
  return payload.inbox.phone_number;
}
