import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";

/**
 * Staff of a broker (advisors who handle exceptions escalated from the bot).
 * §7.1: `UNIQUE (broker_id, phone)`.
 *
 * `admin-dashboard` (C1), design.md D-H: `email` is nullable — existing
 * WhatsApp-only rows carry no email (P2) — and carries a **plain**, globally
 * unique index (`broker_users_email_key`, defined in
 * `migrations/0006_broker_auth.sql`), deliberately not
 * `UNIQUE (broker_id, email)` and deliberately not `NULLS NOT DISTINCT`.
 * Postgres already treats every `NULL` as distinct in a plain unique index,
 * so any number of rows may keep `email IS NULL`; `NULLS NOT DISTINCT` would
 * collapse them into a single row on the second insert. See
 * `test/migrations/broker-auth-migration.test.ts` and
 * `test/migrations/live-broker-auth.test.ts`.
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
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.brokerId, table.phone), unique("broker_users_email_key").on(table.email)],
);
