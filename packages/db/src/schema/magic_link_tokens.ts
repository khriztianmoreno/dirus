import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";
import { brokerUsers } from "./broker_users.js";

/**
 * `admin-dashboard` (C1), design.md D-A/D-H: a one-time magic-link login
 * token. Style mirrors `contacts.ts`'s nullable-timestamp convention exactly
 * — `usedAt` presence means "this token was consumed", which makes
 * single-use enforceable and auditable rather than implicit in a `DELETE`.
 *
 * `tokenHash` is the SHA-256 hex digest of the raw, 32-byte CSPRNG token —
 * the raw value is never persisted anywhere (broker-auth spec, "The stored
 * row contains no raw token"; `test/migrations/live-broker-auth.test.ts`
 * assertion 1.9). Global uniqueness (not scoped per broker), the same
 * accepted trade-off as `messages.wa_message_id` and required by D-A's
 * resolver lookup.
 *
 * `expires_at`/`used_at` are read and enforced only inside
 * `withBrokerContext`, never inside the `SECURITY DEFINER` resolver function
 * (design.md D-A: "the functions decide nothing").
 */
export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    brokerUserId: uuid("broker_user_id")
      .notNull()
      .references(() => brokerUsers.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.tokenHash)],
);
