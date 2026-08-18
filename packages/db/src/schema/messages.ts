import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";
import { conversations } from "./conversations.js";

/**
 * §7.1: `wa_message_id` is UNIQUE (nullable — only inbound/outbound messages
 * that actually round-trip through Meta/Chatwoot carry one), the dedup key
 * for webhook replay. `CREATE INDEX ON messages (conversation_id, created_at)`
 * is a full (non-partial) index.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    direction: text("direction").notNull(), // inbound | outbound
    sender: text("sender").notNull(), // contact | agent_bot | human | system
    type: text("type").notNull(), // text | audio | image | document | template
    body: text("body"),
    // Media always lives in R2 — Meta's media IDs expire.
    mediaR2Key: text("media_r2_key"),
    // Webhook idempotency: dedup here.
    waMessageId: text("wa_message_id").unique(),
    // set when type = template (HSM).
    templateName: text("template_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // §7.2 Chatwoot mirror column — nullable, reference only.
    chatwootMessageId: integer("chatwoot_message_id"),
  },
  (table) => [index().on(table.conversationId, table.createdAt)],
);
