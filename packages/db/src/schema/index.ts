/**
 * Drizzle schema barrel (data-model spec: Core Schema Tables, Chatwoot Mirror
 * Columns, Required Indexes, Idempotency Constraints). Every §7.1 table
 * except `doc_chunks` (deferred to Phase C, data-model spec: "doc_chunks and
 * pgvector table are excluded"), plus the §7.2 nullable `chatwoot_*` columns.
 */
export * from "./brokers.js";
export * from "./broker_users.js";
export * from "./contacts.js";
export * from "./conversations.js";
export * from "./messages.js";
export * from "./policies.js";
export * from "./documents.js";
export * from "./extractions.js";
export * from "./renewals.js";
export * from "./magic_link_tokens.js";
export * from "./sessions.js";
