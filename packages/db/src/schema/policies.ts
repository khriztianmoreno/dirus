import { sql } from "drizzle-orm";
import { date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";
import { contacts } from "./contacts.js";

/**
 * Policies: the central business object. §7.1 partial index:
 * `CREATE INDEX ON policies (broker_id, end_date) WHERE status = 'active'`.
 *
 * `policy-bulk-import` (A1), proposal P5 / data-model delta "Partial Unique
 * Index on Numbered Policies": a second partial index,
 * `CREATE UNIQUE INDEX ON policies (broker_id, policy_number) WHERE
 * policy_number IS NOT NULL`, defines "the same policy" as a
 * `(broker_id, policy_number)` pair only when `policy_number` is present.
 * A plain unique index would pass every test that always supplies a
 * `policy_number` by accident (Postgres already treats NULLs as distinct
 * there too) but misdescribes its own intent; `NULLS NOT DISTINCT` would
 * actively collapse every unnumbered policy for a broker into one row. See
 * `test/migrations/policy-number-unique-index.test.ts` and
 * `test/migrations/live-policy-number-unique-index.test.ts`.
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
    // `eq(table.status, "active")` renders as a bound `$1` placeholder in
    // the generated migration SQL, which is invalid inside a partial index's
    // WHERE clause (no query parameters exist in a raw DDL statement). The
    // `sql` tag embeds the literal directly.
    index()
      .on(table.brokerId, table.endDate)
      .where(sql`${table.status} = 'active'`),
    // policy-bulk-import (A1), proposal P5: partial unique index, not a
    // plain unique index or NULLS NOT DISTINCT (PG15+) — see module
    // docstring above for why the shape is load-bearing.
    uniqueIndex()
      .on(table.brokerId, table.policyNumber)
      .where(sql`${table.policyNumber} IS NOT NULL`),
  ],
);
