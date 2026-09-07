import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { brokers } from "./brokers.js";
import { brokerUsers } from "./broker_users.js";

/**
 * `admin-dashboard` (C1), design.md D-A/D-B/D-H: a dashboard session,
 * resolved server-side from an opaque 32-byte CSPRNG cookie value — never
 * from client-supplied identity (this project's standing rule). Style
 * mirrors `contacts.ts`'s nullable-timestamp convention: `revokedAt`
 * presence means "logout happened", auditable rather than a `DELETE`.
 *
 * `sessionTokenHash`/`csrfTokenHash` are SHA-256 hex digests of two
 * independent 32-byte CSPRNG values (design.md D-B) — the raw session id and
 * CSRF value are never persisted. `sessionTokenHash` is globally unique, the
 * same accepted trade-off as `messages.wa_message_id` and required by D-A's
 * resolver lookup. `idle_expires_at`/`revoked_at` are read and enforced only
 * inside `withBrokerContext`, never inside the `SECURITY DEFINER` resolver
 * function (design.md D-A: "the functions decide nothing").
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id")
      .notNull()
      .references(() => brokers.id),
    brokerUserId: uuid("broker_user_id")
      .notNull()
      .references(() => brokerUsers.id),
    sessionTokenHash: text("session_token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.sessionTokenHash), index().on(table.brokerUserId)],
);
