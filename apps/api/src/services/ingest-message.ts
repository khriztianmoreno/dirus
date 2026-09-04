import { and, desc, eq, sql } from "drizzle-orm";
import { withBrokerContext, schema, type TenantDb } from "@dirus/db";
import type { ChatwootMessageCreatedPayload } from "@dirus/schemas";

/**
 * Design D-5: "the D-2/D-3 transaction; no HTTP types cross this line" —
 * this file is the ONE place `@dirus/db`'s proven primitives
 * (`withBrokerContext`) meet a parsed Chatwoot payload. It never sees a
 * Hono `Context`, a raw request, or an HTTP status code; it takes plain
 * data in and returns plain data out. The route (`routes/webhooks/chatwoot.ts`)
 * is the only caller and owns everything HTTP-shaped (status codes, the
 * post-commit echo call).
 */
export type IngestResult = { deduplicated: boolean };

/**
 * Maps Chatwoot's `content_type` to the `messages.type` column's vocabulary
 * (`text | audio | image | document | template`). Unrecognized content
 * types fall back to `document` rather than throwing — an unknown media
 * kind should still persist (spec "Media Message Persistence"), not crash
 * the pipeline.
 */
function toMessageType(contentType: string): string {
  if (contentType === "text") return "text";
  if (contentType.startsWith("audio")) return "audio";
  if (contentType.startsWith("image")) return "image";
  return "document";
}

/**
 * Design D-2/D-3: the four-statement transaction, in the EXACT order named
 * by design D-2 — load-bearing, not stylistic:
 *
 *   1. contacts upsert — `ON CONFLICT (broker_id, phone) DO UPDATE`
 *      (never `DO NOTHING`): this is the serialization point. Only
 *      `DO UPDATE` takes the row-level exclusive lock that makes a second
 *      concurrent transaction for the same sender BLOCK at this step until
 *      the first commits.
 *   2. SELECT the latest matching conversation for (broker_id, contact_id,
 *      kind='customer').
 *   3. insert a conversation only if step 2 found none.
 *   4. messages insert — `ON CONFLICT (wa_message_id) DO NOTHING` (design
 *      D-3): the dedup point. The losing side of a duplicate takes no row
 *      lock, returns no row, but steps 1-3 above are themselves idempotent,
 *      so the transaction still COMMITS — never rolls back on a duplicate.
 *
 * All four statements run inside ONE `withBrokerContext` transaction.
 */
async function runIngestTransaction(
  tx: TenantDb,
  brokerId: string,
  payload: ChatwootMessageCreatedPayload,
): Promise<IngestResult> {
  const phone = payload.contact.phone_number;
  if (!phone) {
    throw new Error(
      "Chatwoot payload's contact.phone_number is missing — cannot upsert a contacts row " +
        "without a phone number (contacts.phone is NOT NULL).",
    );
  }

  // 1. Contacts upsert — the serialization point (design D-2). `DO UPDATE`,
  // never `DO NOTHING`.
  const [contactRow] = await tx
    .insert(schema.contacts)
    .values({ brokerId, phone })
    .onConflictDoUpdate({
      target: [schema.contacts.brokerId, schema.contacts.phone],
      set: { phone: sql`excluded.phone` },
    })
    .returning({ id: schema.contacts.id });
  const contactId = contactRow.id;

  // 2. Find the latest matching conversation.
  const existingConversations = await tx
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.brokerId, brokerId),
        eq(schema.conversations.contactId, contactId),
        eq(schema.conversations.kind, "customer"),
      ),
    )
    .orderBy(desc(schema.conversations.createdAt))
    .limit(1);

  // 3. Insert one if none found.
  let conversationId: string;
  if (existingConversations.length > 0) {
    conversationId = existingConversations[0].id;
  } else {
    const [conversationRow] = await tx
      .insert(schema.conversations)
      .values({ brokerId, contactId, kind: "customer" })
      .returning({ id: schema.conversations.id });
    conversationId = conversationRow.id;
  }

  // 4. Messages insert — dedup point (design D-3). `media_r2_key` is never
  // set here: this pipeline never attempts a media fetch (spec "Media
  // Message Persistence" / P3), so it stays NULL by construction for every
  // message, media or not.
  const insertedMessages = await tx
    .insert(schema.messages)
    .values({
      brokerId,
      conversationId,
      direction: "inbound",
      sender: "contact",
      type: toMessageType(payload.content_type),
      body: payload.content,
      waMessageId: payload.source_id ?? null,
      chatwootMessageId: payload.id,
    })
    .onConflictDoNothing({ target: schema.messages.waMessageId })
    .returning({ id: schema.messages.id });

  // Losing side of a duplicate (design D-3): no row returned, but steps 1-3
  // above already ran and are idempotent, so this function returns
  // normally — the transaction still commits.
  return { deduplicated: insertedMessages.length === 0 };
}

/**
 * The real ingest pipeline (design D-2/D-3/D-5). Wraps the four-statement
 * transaction above in `withBrokerContext`, the one proven primitive from
 * Phase 1/2 this whole change is built on.
 */
export async function ingestMessage(
  brokerId: string,
  payload: ChatwootMessageCreatedPayload,
): Promise<IngestResult> {
  return withBrokerContext(brokerId, (tx) => runIngestTransaction(tx, brokerId, payload));
}
