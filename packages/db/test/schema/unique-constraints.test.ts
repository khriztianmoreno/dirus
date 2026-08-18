import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/schema/index.js";

/**
 * data-model spec — Requirement "Idempotency Constraints": every listed
 * UNIQUE constraint must exist. Structural check against the Drizzle table
 * config (this batch produces the schema, not the generated migration or a
 * live database — see chatwoot-columns.test.ts for the same scoping note).
 */
describe("idempotency UNIQUE constraints (data-model spec)", () => {
  it("brokers.wa_phone_number_id is UNIQUE (tenant resolution per webhook)", () => {
    const column = getTableConfig(schema.brokers).columns.find(
      (c) => c.name === "wa_phone_number_id",
    );
    expect(column?.isUnique).toBe(true);
  });

  it("messages.wa_message_id is UNIQUE (Meta/Chatwoot webhook replay dedup)", () => {
    const column = getTableConfig(schema.messages).columns.find((c) => c.name === "wa_message_id");
    expect(column?.isUnique).toBe(true);
  });

  it.each([
    { table: schema.renewals, columns: ["policy_id", "due_date"], label: "renewal cron re-run dedup" },
    { table: schema.contacts, columns: ["broker_id", "phone"], label: "contacts per broker" },
    {
      table: schema.brokerUsers,
      columns: ["broker_id", "phone"],
      label: "broker_users per broker",
    },
  ])(
    "$label has the expected composite UNIQUE constraint",
    ({ table, columns }: { table: PgTable; columns: string[]; label: string }) => {
      const match = getTableConfig(table).uniqueConstraints.find(
        (c) =>
          c.columns.length === columns.length &&
          c.columns.every((col, i) => col.name === columns[i]),
      );
      expect(
        match,
        `expected UNIQUE (${columns.join(", ")}) on "${getTableName(table)}"`,
      ).toBeDefined();
    },
  );
});
