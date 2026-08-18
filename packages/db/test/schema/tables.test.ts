import { describe, expect, it } from "vitest";
import { CasingCache } from "drizzle-orm/casing";
import type { SQL } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/schema/index.js";

/**
 * data-model spec — "Core Schema Tables", "Chatwoot Mirror Columns",
 * "Required Indexes", "Idempotency Constraints": every §7.1/§7.2 table,
 * column, type, default, FK, index, and UNIQUE constraint must match
 * `docs/ARCHITECTURE.md` §7.1/§7.2 exactly.
 *
 * This is a STRUCTURAL checklist against the Drizzle table definitions
 * (via `getTableConfig`), not a live-database test: Phase 3 (this batch)
 * produces the Drizzle schema only. Generated migration SQL is Phase 4;
 * live-Postgres proof of INSERT/UNIQUE-violation behavior is Phase 4
 * (static SQL assertions) and Phase 6 (live Neon integration) per
 * tasks.md's phase boundaries. Every assertion below reads real config
 * produced by the actual column builders — it is not a tautology: a wrong
 * type, a missing NOT NULL, a missing default, or a missing FK reference
 * makes the corresponding assertion fail.
 */

function renderDefault(column: PgColumn): unknown {
  const raw = column.default as unknown;
  if (raw !== null && typeof raw === "object" && typeof (raw as SQL).toQuery === "function") {
    const { sql: renderedSql } = (raw as SQL).toQuery({
      casing: new CasingCache(),
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (n: number) => `$${n + 1}`,
      escapeString: (str: string) => `'${str}'`,
    });
    return renderedSql;
  }
  return raw;
}

function findColumn(table: PgTable, dbColumnName: string): PgColumn {
  const column = getTableConfig(table).columns.find((c) => c.name === dbColumnName);
  if (!column) {
    throw new Error(`Column "${dbColumnName}" not found on table "${getTableName(table)}"`);
  }
  return column;
}

interface ColumnExpectation {
  name: string;
  sqlType: string;
  notNull: boolean;
  hasDefault?: boolean;
  defaultValue?: unknown;
  isUnique?: boolean;
  references?: { table: PgTable; column: string };
}

function assertColumn(table: PgTable, expected: ColumnExpectation): void {
  const column = findColumn(table, expected.name);

  expect(column.getSQLType()).toBe(expected.sqlType);
  expect(column.notNull).toBe(expected.notNull);

  if (expected.hasDefault !== undefined) {
    expect(column.hasDefault).toBe(expected.hasDefault);
  }
  if (expected.defaultValue !== undefined) {
    expect(renderDefault(column)).toBe(expected.defaultValue);
  }
  if (expected.isUnique !== undefined) {
    expect(column.isUnique).toBe(expected.isUnique);
  }
  if (expected.references) {
    const fk = getTableConfig(table).foreignKeys.find((candidate) =>
      candidate.reference().columns.some((c) => c.name === expected.name),
    );
    expect(fk, `expected a FK on "${expected.name}"`).toBeDefined();
    const ref = fk!.reference();
    expect(getTableName(ref.foreignTable)).toBe(getTableName(expected.references.table));
    expect(ref.foreignColumns[0]!.name).toBe(expected.references.column);
  }
}

function assertUniqueConstraint(table: PgTable, columnNames: string[]): void {
  const constraints = getTableConfig(table).uniqueConstraints;
  const match = constraints.find(
    (c) =>
      c.columns.length === columnNames.length &&
      c.columns.every((col, i) => col.name === columnNames[i]),
  );
  expect(
    match,
    `expected a UNIQUE (${columnNames.join(", ")}) constraint on "${getTableName(table)}"`,
  ).toBeDefined();
}

describe("brokers (§7.1)", () => {
  it("matches every column, type, default, and unique constraint", () => {
    assertColumn(schema.brokers, {
      name: "id",
      sqlType: "uuid",
      notNull: true,
      hasDefault: true,
      defaultValue: "gen_random_uuid()",
    });
    assertColumn(schema.brokers, { name: "name", sqlType: "text", notNull: true });
    assertColumn(schema.brokers, {
      name: "wa_phone_number_id",
      sqlType: "text",
      notNull: true,
      isUnique: true,
    });
    assertColumn(schema.brokers, { name: "waba_id", sqlType: "text", notNull: true });
    assertColumn(schema.brokers, {
      name: "plan",
      sqlType: "text",
      notNull: true,
      defaultValue: "pilot",
    });
    assertColumn(schema.brokers, {
      name: "status",
      sqlType: "text",
      notNull: true,
      defaultValue: "active",
    });
    assertColumn(schema.brokers, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });

  it("has the §7.2 nullable chatwoot_account_id (integer, unique)", () => {
    assertColumn(schema.brokers, {
      name: "chatwoot_account_id",
      sqlType: "integer",
      notNull: false,
      isUnique: true,
    });
  });
});

describe("broker_users (§7.1)", () => {
  it("matches every column, type, default, and FK", () => {
    assertColumn(schema.brokerUsers, { name: "id", sqlType: "uuid", notNull: true, hasDefault: true });
    assertColumn(schema.brokerUsers, {
      name: "broker_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.brokers, column: "id" },
    });
    assertColumn(schema.brokerUsers, { name: "name", sqlType: "text", notNull: true });
    assertColumn(schema.brokerUsers, { name: "phone", sqlType: "text", notNull: true });
    assertColumn(schema.brokerUsers, {
      name: "role",
      sqlType: "text",
      notNull: true,
      defaultValue: "agent",
    });
    assertColumn(schema.brokerUsers, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });

  it("has UNIQUE (broker_id, phone)", () => {
    assertUniqueConstraint(schema.brokerUsers, ["broker_id", "phone"]);
  });
});

describe("contacts (§7.1)", () => {
  it("matches every column, type, and FK, including nullable fields", () => {
    assertColumn(schema.contacts, { name: "id", sqlType: "uuid", notNull: true, hasDefault: true });
    assertColumn(schema.contacts, {
      name: "broker_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.brokers, column: "id" },
    });
    assertColumn(schema.contacts, { name: "phone", sqlType: "text", notNull: true });
    assertColumn(schema.contacts, { name: "full_name", sqlType: "text", notNull: false });
    assertColumn(schema.contacts, { name: "doc_type", sqlType: "text", notNull: false });
    assertColumn(schema.contacts, { name: "doc_number", sqlType: "text", notNull: false });
    assertColumn(schema.contacts, {
      name: "consent_at",
      sqlType: "timestamp with time zone",
      notNull: false,
    });
    assertColumn(schema.contacts, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });

  it("has UNIQUE (broker_id, phone)", () => {
    assertUniqueConstraint(schema.contacts, ["broker_id", "phone"]);
  });

  it("has the §7.2 nullable chatwoot_contact_id (integer)", () => {
    assertColumn(schema.contacts, { name: "chatwoot_contact_id", sqlType: "integer", notNull: false });
  });
});

describe("conversations (§7.1)", () => {
  it("matches every column, type, and FK, including nullable fields", () => {
    assertColumn(schema.conversations, { name: "id", sqlType: "uuid", notNull: true, hasDefault: true });
    assertColumn(schema.conversations, {
      name: "broker_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.brokers, column: "id" },
    });
    assertColumn(schema.conversations, {
      name: "contact_id",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.contacts, column: "id" },
    });
    assertColumn(schema.conversations, {
      name: "broker_user_id",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.brokerUsers, column: "id" },
    });
    assertColumn(schema.conversations, { name: "kind", sqlType: "text", notNull: true });
    assertColumn(schema.conversations, {
      name: "status",
      sqlType: "text",
      notNull: true,
      defaultValue: "bot",
    });
    assertColumn(schema.conversations, {
      name: "escalation_reason",
      sqlType: "text",
      notNull: false,
    });
    assertColumn(schema.conversations, {
      name: "window_expires_at",
      sqlType: "timestamp with time zone",
      notNull: false,
    });
    assertColumn(schema.conversations, {
      name: "last_message_at",
      sqlType: "timestamp with time zone",
      notNull: false,
    });
    assertColumn(schema.conversations, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });

  it("has the §7.2 nullable chatwoot_conversation_id (integer)", () => {
    assertColumn(schema.conversations, {
      name: "chatwoot_conversation_id",
      sqlType: "integer",
      notNull: false,
    });
  });
});

describe("messages (§7.1)", () => {
  it("matches every column, type, default, and FK, including nullable fields", () => {
    assertColumn(schema.messages, { name: "id", sqlType: "uuid", notNull: true, hasDefault: true });
    assertColumn(schema.messages, {
      name: "broker_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.brokers, column: "id" },
    });
    assertColumn(schema.messages, {
      name: "conversation_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.conversations, column: "id" },
    });
    assertColumn(schema.messages, { name: "direction", sqlType: "text", notNull: true });
    assertColumn(schema.messages, { name: "sender", sqlType: "text", notNull: true });
    assertColumn(schema.messages, { name: "type", sqlType: "text", notNull: true });
    assertColumn(schema.messages, { name: "body", sqlType: "text", notNull: false });
    assertColumn(schema.messages, { name: "media_r2_key", sqlType: "text", notNull: false });
    assertColumn(schema.messages, {
      name: "wa_message_id",
      sqlType: "text",
      notNull: false,
      isUnique: true,
    });
    assertColumn(schema.messages, { name: "template_name", sqlType: "text", notNull: false });
    assertColumn(schema.messages, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });

  it("has the §7.2 nullable chatwoot_message_id (integer)", () => {
    assertColumn(schema.messages, { name: "chatwoot_message_id", sqlType: "integer", notNull: false });
  });

  it("has a non-partial index on (conversation_id, created_at)", () => {
    const idx = getTableConfig(schema.messages).indexes.find(
      (candidate) =>
        candidate.config.columns.length === 2 &&
        (candidate.config.columns[0] as PgColumn).name === "conversation_id" &&
        (candidate.config.columns[1] as PgColumn).name === "created_at",
    );
    expect(idx).toBeDefined();
    expect(idx!.config.where).toBeUndefined();
  });
});

describe("policies (§7.1)", () => {
  it("matches every column, type, default, and FK, including nullable fields", () => {
    assertColumn(schema.policies, { name: "id", sqlType: "uuid", notNull: true, hasDefault: true });
    assertColumn(schema.policies, {
      name: "broker_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.brokers, column: "id" },
    });
    assertColumn(schema.policies, {
      name: "contact_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.contacts, column: "id" },
    });
    assertColumn(schema.policies, { name: "insurer", sqlType: "text", notNull: true });
    assertColumn(schema.policies, { name: "line", sqlType: "text", notNull: true });
    assertColumn(schema.policies, { name: "policy_number", sqlType: "text", notNull: false });
    assertColumn(schema.policies, { name: "plate", sqlType: "text", notNull: false });
    assertColumn(schema.policies, {
      name: "premium_amount",
      sqlType: "numeric(14, 2)",
      notNull: false,
    });
    assertColumn(schema.policies, {
      name: "currency",
      sqlType: "text",
      notNull: true,
      defaultValue: "COP",
    });
    assertColumn(schema.policies, {
      name: "commission_pct",
      sqlType: "numeric(5, 2)",
      notNull: false,
    });
    assertColumn(schema.policies, { name: "start_date", sqlType: "date", notNull: false });
    assertColumn(schema.policies, { name: "end_date", sqlType: "date", notNull: true });
    assertColumn(schema.policies, {
      name: "status",
      sqlType: "text",
      notNull: true,
      defaultValue: "active",
    });
    assertColumn(schema.policies, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });

  it("has a PARTIAL index on (broker_id, end_date) WHERE status = 'active'", () => {
    const idx = getTableConfig(schema.policies).indexes.find(
      (candidate) =>
        candidate.config.columns.length === 2 &&
        (candidate.config.columns[0] as PgColumn).name === "broker_id" &&
        (candidate.config.columns[1] as PgColumn).name === "end_date",
    );
    expect(idx).toBeDefined();
    expect(idx!.config.where).toBeDefined();

    const { sql: whereSql, params } = idx!.config.where!.toQuery({
      casing: new CasingCache(),
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (n: number) => `$${n + 1}`,
      escapeString: (str: string) => `'${str}'`,
    });
    // Built with the `sql` tag (not `eq()`), which embeds the literal
    // directly instead of a bound $N placeholder — required because a
    // partial index's WHERE clause has no query-parameter binding at
    // migration-apply time (see packages/db/src/schema/policies.ts and
    // packages/db/test/migrations/partial-indexes.test.ts).
    expect(whereSql).toContain('"status" = \'active\'');
    expect(params).toEqual([]);
  });
});

describe("documents (§7.1)", () => {
  it("matches every column, type, and FK, including nullable fields", () => {
    assertColumn(schema.documents, { name: "id", sqlType: "uuid", notNull: true, hasDefault: true });
    assertColumn(schema.documents, {
      name: "broker_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.brokers, column: "id" },
    });
    assertColumn(schema.documents, {
      name: "policy_id",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.policies, column: "id" },
    });
    assertColumn(schema.documents, {
      name: "contact_id",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.contacts, column: "id" },
    });
    assertColumn(schema.documents, {
      name: "message_id",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.messages, column: "id" },
    });
    assertColumn(schema.documents, { name: "r2_key", sqlType: "text", notNull: true });
    assertColumn(schema.documents, { name: "mime_type", sqlType: "text", notNull: true });
    assertColumn(schema.documents, { name: "doc_class", sqlType: "text", notNull: false });
    assertColumn(schema.documents, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });
});

describe("extractions (§7.1)", () => {
  it("matches every column, type, default, and FK, including nullable fields", () => {
    assertColumn(schema.extractions, { name: "id", sqlType: "uuid", notNull: true, hasDefault: true });
    assertColumn(schema.extractions, {
      name: "broker_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.brokers, column: "id" },
    });
    assertColumn(schema.extractions, {
      name: "document_id",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.documents, column: "id" },
    });
    assertColumn(schema.extractions, {
      name: "message_id",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.messages, column: "id" },
    });
    assertColumn(schema.extractions, { name: "model", sqlType: "text", notNull: true });
    assertColumn(schema.extractions, { name: "output", sqlType: "jsonb", notNull: true });
    assertColumn(schema.extractions, { name: "confidence", sqlType: "jsonb", notNull: true });
    assertColumn(schema.extractions, {
      name: "needs_review",
      sqlType: "boolean",
      notNull: true,
      defaultValue: false,
    });
    assertColumn(schema.extractions, { name: "corrected_output", sqlType: "jsonb", notNull: false });
    assertColumn(schema.extractions, {
      name: "corrected_by",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.brokerUsers, column: "id" },
    });
    assertColumn(schema.extractions, {
      name: "langfuse_trace_id",
      sqlType: "text",
      notNull: false,
    });
    assertColumn(schema.extractions, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });

  it("has a PARTIAL index on (broker_id, needs_review) WHERE needs_review = true", () => {
    const idx = getTableConfig(schema.extractions).indexes.find(
      (candidate) =>
        candidate.config.columns.length === 2 &&
        (candidate.config.columns[0] as PgColumn).name === "broker_id" &&
        (candidate.config.columns[1] as PgColumn).name === "needs_review",
    );
    expect(idx).toBeDefined();
    expect(idx!.config.where).toBeDefined();

    const { sql: whereSql, params } = idx!.config.where!.toQuery({
      casing: new CasingCache(),
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (n: number) => `$${n + 1}`,
      escapeString: (str: string) => `'${str}'`,
    });
    // Built with the `sql` tag (not `eq()`) for the same reason as the
    // policies partial index above — see
    // packages/db/src/schema/extractions.ts.
    expect(whereSql).toContain('"needs_review" = true');
    expect(params).toEqual([]);
  });
});

describe("renewals (§7.1)", () => {
  it("matches every column, type, default, and FK, including nullable fields", () => {
    assertColumn(schema.renewals, { name: "id", sqlType: "uuid", notNull: true, hasDefault: true });
    assertColumn(schema.renewals, {
      name: "broker_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.brokers, column: "id" },
    });
    assertColumn(schema.renewals, {
      name: "policy_id",
      sqlType: "uuid",
      notNull: true,
      references: { table: schema.policies, column: "id" },
    });
    assertColumn(schema.renewals, {
      name: "conversation_id",
      sqlType: "uuid",
      notNull: false,
      references: { table: schema.conversations, column: "id" },
    });
    assertColumn(schema.renewals, { name: "due_date", sqlType: "date", notNull: true });
    assertColumn(schema.renewals, { name: "workflow_run_id", sqlType: "text", notNull: false });
    assertColumn(schema.renewals, {
      name: "status",
      sqlType: "text",
      notNull: true,
      defaultValue: "pending",
    });
    assertColumn(schema.renewals, { name: "payment_link", sqlType: "text", notNull: false });
    assertColumn(schema.renewals, {
      name: "paid_at",
      sqlType: "timestamp with time zone",
      notNull: false,
    });
    assertColumn(schema.renewals, {
      name: "escalated_at",
      sqlType: "timestamp with time zone",
      notNull: false,
    });
    assertColumn(schema.renewals, {
      name: "created_at",
      sqlType: "timestamp with time zone",
      notNull: true,
      defaultValue: "now()",
    });
  });

  it("has UNIQUE (policy_id, due_date)", () => {
    assertUniqueConstraint(schema.renewals, ["policy_id", "due_date"]);
  });
});

describe("doc_chunks is excluded (D4: deferred to Phase C)", () => {
  it("no schema module exports a doc_chunks table", () => {
    const exportedTableNames = Object.values(schema)
      .filter((value) => typeof value === "object" && value !== null && "_" in value)
      .map((table) => getTableName(table as PgTable));

    expect(exportedTableNames).not.toContain("doc_chunks");
  });
});
