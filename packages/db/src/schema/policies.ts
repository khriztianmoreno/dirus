import { eq } from "drizzle-orm";
import { date, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";
import { contacts } from "./contacts.js";

/**
 * Policies: the central business object. §7.1 partial index:
 * `CREATE INDEX ON policies (broker_id, end_date) WHERE status = 'active'`.
 */
export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    insurer: text("insurer").notNull(), // Sura, Bolívar, Allianz...
    line: text("line").notNull(), // auto | vida | hogar | salud | soat
    policyNumber: text("policy_number"),
    plate: text("plate"), // auto lines
    premiumAmount: numeric("premium_amount", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("COP"),
    commissionPct: numeric("commission_pct", { precision: 5, scale: 2 }),
    startDate: date("start_date"),
    // Triggers the renewal cron.
    endDate: date("end_date").notNull(),
    status: text("status").notNull().default("active"), // active | expired | cancelled
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index()
      .on(table.brokerId, table.endDate)
      .where(eq(table.status, "active")),
  ],
);
