import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/schema/index.js";

/**
 * data-model spec — Requirement "Chatwoot Mirror Columns", Scenario
 * "Chatwoot columns are nullable": inserting into brokers/contacts/
 * conversations/messages without a chatwoot_* value must succeed.
 *
 * STRUCTURAL PROXY, not a live INSERT: this batch (Phase 3, schema only) has
 * no generated migration and no live Postgres connection available (same
 * constraint documented for the Phase 2 live round-trip test). A column
 * accepts an omitted value on insert if and only if Postgres does not enforce
 * NOT NULL on it — i.e. `column.notNull === false` at the Drizzle level. This
 * is the exact condition the generated `CREATE TABLE` DDL will encode, so
 * asserting it here is equivalent for the purpose of this scenario. Live
 * INSERT proof against a real Neon database belongs to Phase 6.
 */
describe("chatwoot_* mirror columns are nullable (§7.2, insert without a value must succeed)", () => {
  const cases: Array<{ table: PgTable; column: string }> = [
    { table: schema.brokers, column: "chatwoot_account_id" },
    { table: schema.contacts, column: "chatwoot_contact_id" },
    { table: schema.conversations, column: "chatwoot_conversation_id" },
    { table: schema.messages, column: "chatwoot_message_id" },
  ];

  it.each(cases)("$column has no NOT NULL constraint", ({ table, column }) => {
    const found = getTableConfig(table).columns.find((c) => c.name === column);
    expect(found, `expected column "${column}" to exist`).toBeDefined();
    expect(found!.notNull).toBe(false);
  });
});
