import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Tenants. `broker_id` (or `id` here) appears in every other §7.1 table
 * (docs/ARCHITECTURE.md §7.1). `wa_phone_number_id` resolves the tenant on
 * every inbound WhatsApp webhook.
 */
export const brokers = pgTable("brokers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  waPhoneNumberId: text("wa_phone_number_id").notNull().unique(),
  wabaId: text("waba_id").notNull(),
  plan: text("plan").notNull().default("pilot"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // §7.2 Chatwoot mirror column — nullable, reference only, never source of truth.
  chatwootAccountId: integer("chatwoot_account_id").unique(),
});
