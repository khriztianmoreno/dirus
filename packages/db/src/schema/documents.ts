import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";
import { contacts } from "./contacts.js";
import { messages } from "./messages.js";
import { policies } from "./policies.js";

/**
 * Source documents (cover pages, ID cards, vehicle registration cards).
 */
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  brokerId: uuid("broker_id")
    .notNull()
    .references(() => brokers.id),
  policyId: uuid("policy_id").references(() => policies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  // which message it arrived from.
  messageId: uuid("message_id").references(() => messages.id),
  r2Key: text("r2_key").notNull(),
  mimeType: text("mime_type").notNull(),
  docClass: text("doc_class"), // caratula | cedula | tarjeta_propiedad | factura
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
