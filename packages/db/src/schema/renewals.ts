import { date, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";
import { conversations } from "./conversations.js";
import { policies } from "./policies.js";

/**
 * Renewal workflow state — where the business actually lives. §7.1:
 * `UNIQUE (policy_id, due_date)` — idempotency for the renewal cron.
 */
export const renewals = pgTable(
  "renewals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id),
    conversationId: uuid("conversation_id").references(() => conversations.id),
    dueDate: date("due_date").notNull(),
    // id of the Trigger.dev/Mastra run.
    workflowRunId: text("workflow_run_id"),
    status: text("status").notNull().default("pending"),
    // pending | contacted | negotiating | payment_sent | paid | escalated | lost
    paymentLink: text("payment_link"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.policyId, table.dueDate)],
);
