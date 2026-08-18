import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { brokerUsers } from "./broker_users.js";
import { brokers } from "./brokers.js";
import { documents } from "./documents.js";
import { messages } from "./messages.js";

/**
 * The heart of the flywheel: every extraction and its human correction.
 * §7.1 partial index:
 * `CREATE INDEX ON extractions (broker_id, needs_review) WHERE needs_review = true`.
 */
export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    documentId: uuid("document_id").references(() => documents.id),
    // for voice-note extractions.
    messageId: uuid("message_id").references(() => messages.id),
    model: text("model").notNull(), // gemini-3.1-flash, etc.
    output: jsonb("output").notNull(), // Zod-validated JSON
    confidence: jsonb("confidence").notNull(), // per-field score
    needsReview: boolean("needs_review").notNull().default(false), // confidence below threshold
    correctedOutput: jsonb("corrected_output"), // human correction = gold data
    correctedBy: uuid("corrected_by").references(() => brokerUsers.id),
    langfuseTraceId: text("langfuse_trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // `eq(table.needsReview, true)` renders as a bound `$1` placeholder in
    // the generated migration SQL, which is invalid inside a partial index's
    // WHERE clause (no query parameters exist in a raw DDL statement). The
    // `sql` tag embeds the literal directly.
    index()
      .on(table.brokerId, table.needsReview)
      .where(sql`${table.needsReview} = true`),
  ],
);
