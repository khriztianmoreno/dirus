import { z } from "zod";

/**
 * Chatwoot `message_created` webhook payload — two-stage parse (design D-6,
 * corrected by F2.1 design D-A).
 *
 * **Confirmed against a real captured payload** (self-hosted Chatwoot,
 * `Channel::Whatsapp`, event `message_created`/`incoming`, captured
 * 2026-09-07 — see `test/fixtures/chatwoot-message-created.json`, committed
 * verbatim). This closed F2 task 4.8 and resolved proposal O4: Chatwoot does
 * not expose Meta's `wa_phone_number_id` anywhere in the payload, and
 * `inbox` never carries a `phone_number` field. The resolution key is
 * `account.id`, matched against `brokers.chatwoot_account_id` — F2.1's
 * settled fallback (F2 design D-6 named this contingency in advance).
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

const chatwootConversationSchema = z.object({
  id: z.number(),
});

const chatwootAccountSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
});

// A real `inbox` object only ever contains `{id, name}` (confirmed against
// the captured payload) — `phone_number` does not exist here, ever. Kept
// narrow rather than optional: an optional field nobody reads is a field a
// future reader will assume can be read (design D-A).
const chatwootInboxSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
});

export const chatwootMessageCreatedPayloadSchema = z.object({
  event: z.literal("message_created"),
  id: z.number(),
  content: z.string().nullable(),
  message_type: z.literal("incoming"),
  content_type: z.string(),
  source_id: z.string().nullable().optional(),
  sender: chatwootSenderSchema,
  conversation: chatwootConversationSchema,
  account: chatwootAccountSchema,
  inbox: chatwootInboxSchema,
});

export type ChatwootMessageCreatedPayload = z.infer<typeof chatwootMessageCreatedPayloadSchema>;

const MAX_INT4 = 2_147_483_647;

/**
 * The single, deliberately isolated point of contact with "which field
 * carries the resolution key" (F2 design D-6, corrected by F2.1 design
 * D-A/D-B). Every caller that needs the key for
 * `resolveBrokerIdByChatwootAccountId` must go through this function — never
 * read `payload.account.id` directly.
 *
 * Returns `null` — never throws, never a sentinel number — when the key is
 * absent or is not a value `chatwoot_account_id` (a Postgres `integer`)
 * could ever hold. This is also the int4 boundary guard (design D-B): a
 * non-integer, non-positive, or out-of-`int4`-range `account.id` is refused
 * here, before any query runs, so it never reaches Postgres as a numeric
 * overflow (which would otherwise surface as a 500).
 */
export function extractResolutionKey(
  payload: ChatwootMessageCreatedPayload,
): number | null {
  const id = payload.account?.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > MAX_INT4) {
    return null;
  }
  return id;
}
