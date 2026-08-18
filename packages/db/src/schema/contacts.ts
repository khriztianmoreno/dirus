import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";

/**
 * End customers (insured parties). §7.1: `UNIQUE (broker_id, phone)`.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    phone: text("phone").notNull(),
    fullName: text("full_name"),
    docType: text("doc_type"),
    docNumber: text("doc_number"),
    // Habeas Data: explicit consent timestamp.
    consentAt: timestamp("consent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // §7.2 Chatwoot mirror column — nullable, reference only.
    chatwootContactId: integer("chatwoot_contact_id"),
  },
  (table) => [unique().on(table.brokerId, table.phone)],
);
