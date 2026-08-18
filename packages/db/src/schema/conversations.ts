import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { brokerUsers } from "./broker_users.js";
import { brokers } from "./brokers.js";
import { contacts } from "./contacts.js";

/**
 * WhatsApp conversations — either with a customer (`contact_id` set) or the
 * broker's own copilot (`broker_user_id` set).
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  brokerId: uuid("broker_id")
    .notNull()
    .references(() => brokers.id),
  // null if this is a copilot conversation.
  contactId: uuid("contact_id").references(() => contacts.id),
  // set if this is a copilot conversation.
  brokerUserId: uuid("broker_user_id").references(() => brokerUsers.id),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("bot"),
  escalationReason: text("escalation_reason"),
  // WhatsApp's 24h free-form messaging window.
  windowExpiresAt: timestamp("window_expires_at", { withTimezone: true }),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // §7.2 Chatwoot mirror column — nullable, reference only.
  chatwootConversationId: integer("chatwoot_conversation_id"),
});
