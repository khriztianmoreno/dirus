import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 6.4 (`policy-bulk-import`): the real `ResolveBrokerExists` wiring for
 * `apps/api`'s `runImportGuards` (Phase 4). Reuses `withBrokerContext`
 * "as-is" (tasks.md Phase 1 note) rather than adding a new migration or
 * SECURITY DEFINER function: `brokers`'s own `tenant_isolation` RLS policy
 * (0002) is keyed on `id = current_setting('app.broker_id')`, so scoping the
 * read to the CANDIDATE id being checked is itself the existence check — a
 * row is visible under its own id's context if and only if it exists.
 *
 * Fully offline, mirroring `tenant.test.ts`/`tenant-resolution.test.ts`'s
 * `vi.doMock("../src/internal/client.js", ...)` convention — never a live
 * database. `withBrokerContext`'s own transaction/RLS-scoping mechanics are
 * already proven by `tenant.test.ts` and the live RLS suites; this file only
 * proves `brokerExists` calls that proven mechanism correctly and maps its
 * result (row present/absent, or a malformed id) to a boolean.
 */
describe("brokerExists (task 6.4: real broker-lookup dependency, reusing withBrokerContext as-is)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://user:pass@ep-cool-thing-pooler.us-east-2.aws.neon.tech/dirus";
  });

  function mockTx(rows: unknown[]) {
    const limit = vi.fn(async () => rows);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    return { execute: vi.fn(async () => ({ rows: [] })), select };
  }

  it("returns false for a malformed UUID without opening a transaction", async () => {
    const transactionSpy = vi.fn();
    vi.doMock("../src/internal/client.js", () => ({
      db: { transaction: transactionSpy },
    }));

    const { brokerExists } = await import("../src/broker-existence.js");

    await expect(brokerExists("not-a-uuid")).resolves.toBe(false);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("returns true when the id-scoped select finds a matching row", async () => {
    const tx = mockTx([{ id: "123e4567-e89b-12d3-a456-426614174000" }]);
    vi.doMock("../src/internal/client.js", () => ({
      db: { transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) },
    }));

    const { brokerExists } = await import("../src/broker-existence.js");

    await expect(brokerExists("123e4567-e89b-12d3-a456-426614174000")).resolves.toBe(true);
    expect(tx.select).toHaveBeenCalledTimes(1);
  });

  it("returns false when the id-scoped select finds no matching row (unknown broker)", async () => {
    const tx = mockTx([]);
    vi.doMock("../src/internal/client.js", () => ({
      db: { transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) },
    }));

    const { brokerExists } = await import("../src/broker-existence.js");

    await expect(brokerExists("123e4567-e89b-12d3-a456-426614174000")).resolves.toBe(false);
  });
});
