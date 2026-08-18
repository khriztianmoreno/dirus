import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";

/**
 * Staff of a broker (advisors who handle exceptions escalated from the bot).
 * §7.1: `UNIQUE (broker_id, phone)`.
 */
export const brokerUsers = pgTable(
  "broker_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    role: text("role").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.brokerId, table.phone)],
);
