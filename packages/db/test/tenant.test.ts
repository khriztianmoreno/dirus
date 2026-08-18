import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";

// design.md D-E: assertUuid is the belt to the nullif(...) suspenders — it
// rejects malformed input before it is ever interpolated into set_config().
describe("assertUuid (design.md D-E: reject malformed broker ids before they reach SQL)", () => {
  it("rejects a malformed UUID", async () => {
    const { assertUuid } = await import("../src/tenant.js");
    expect(() => assertUuid("not-a-uuid")).toThrow(/uuid/i);
  });

  it("rejects an empty string", async () => {
    const { assertUuid } = await import("../src/tenant.js");
    expect(() => assertUuid("")).toThrow(/uuid/i);
  });

  it("accepts a well-formed UUID", async () => {
    const { assertUuid } = await import("../src/tenant.js");
    expect(() => assertUuid("123e4567-e89b-12d3-a456-426614174000")).not.toThrow();
  });
});

// design.md D-C + data-model spec (Requirement: withBrokerContext Transaction
// Helper, Scenario "Helper scopes broker_id to the transaction only"):
// two sequential calls on the same pooled connection must never leak the
// prior call's app.broker_id setting. set_config's third argument (is_local)
// must be `true`, i.e. scoped to the transaction, never a session-level SET.
describe("withBrokerContext (design.md D-C: transaction-scoped tenant context)", () => {
  function makeTx() {
    return {
      execute: vi.fn(async () => {
        return { rows: [] };
      }),
    };
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL =
      "postgres://user:pass@ep-cool-thing-pooler.us-east-2.aws.neon.tech/dirus";
  });

  it("wraps fn in db.transaction and calls set_config with is_local=true before invoking fn", async () => {
    vi.doMock("../src/internal/client.js", () => {
      const tx = makeTx();
      return {
        db: {
          transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
        },
        __tx: tx,
      };
    });

    const { withBrokerContext } = await import("../src/tenant.js");
    const clientModule = (await import("../src/internal/client.js")) as unknown as {
      __tx: { execute: ReturnType<typeof vi.fn> };
    };

    const brokerId = "123e4567-e89b-12d3-a456-426614174000";
    const result = await withBrokerContext(brokerId, async (tx) => {
      expect(tx).toBe(clientModule.__tx);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(clientModule.__tx.execute).toHaveBeenCalledTimes(1);
    const [query] = clientModule.__tx.execute.mock.calls[0] as [SQL];
    const { sql: renderedSql, params } = query.toQuery({
      casing: new CasingCache(),
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (n: number) => `$${n + 1}`,
      escapeString: (str: string) => `'${str}'`,
    });

    expect(renderedSql).toContain("set_config(");
    expect(renderedSql).toContain("app.broker_id");
    // `true` must be the literal third argument (is_local), never bound as a
    // param — this is what scopes the setting to the transaction only.
    expect(renderedSql.trim().endsWith("true)")).toBe(true);
    expect(params).toEqual([brokerId]);
  });

  it("rejects a malformed brokerId before opening a transaction", async () => {
    const transactionSpy = vi.fn();
    vi.doMock("../src/internal/client.js", () => ({
      db: { transaction: transactionSpy },
    }));

    const { withBrokerContext } = await import("../src/tenant.js");

    await expect(withBrokerContext("not-a-uuid", async () => "unreachable")).rejects.toThrow(
      /uuid/i,
    );
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  // Reentrancy hazard: under drizzle-orm/node-postgres, `db.transaction()`
  // always checks out a connection from the module-level `db`/Pool, never
  // the current `tx`. A nested call therefore opens a SECOND, unrelated
  // transaction — an outer rollback would not undo the inner commit, and it
  // can deadlock a small/exhausted pool. This must throw, not silently
  // reuse the outer transaction (which would also mask a broker-id mismatch
  // if the nested call requested a different brokerId).
  it("throws when withBrokerContext is called reentrantly from within an outer call", async () => {
    vi.doMock("../src/internal/client.js", () => {
      const tx = makeTx();
      return {
        db: {
          transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
        },
        __tx: tx,
      };
    });

    const { withBrokerContext } = await import("../src/tenant.js");

    const outerBrokerId = "123e4567-e89b-12d3-a456-426614174000";
    const innerBrokerId = "223e4567-e89b-12d3-a456-426614174000";

    await expect(
      withBrokerContext(outerBrokerId, async () => {
        return withBrokerContext(innerBrokerId, async () => "unreachable");
      }),
    ).rejects.toThrow(/reentrant|nested/i);
  });

  // Regression lock: two INDEPENDENT withBrokerContext calls (different
  // async contexts, different broker ids) running concurrently must NOT
  // false-positive as reentrant. This is the guarantee whose regression
  // would be a production outage (see AsyncLocalStorage limitation
  // documented next to `inBrokerContext` in src/tenant.ts).
  it("does not throw for two independent concurrent withBrokerContext calls with different broker ids", async () => {
    vi.doMock("../src/internal/client.js", () => {
      return {
        db: {
          transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx())),
        },
      };
    });

    const { withBrokerContext } = await import("../src/tenant.js");

    const brokerIdA = "123e4567-e89b-12d3-a456-426614174000";
    const brokerIdB = "223e4567-e89b-12d3-a456-426614174000";

    await expect(
      Promise.all([
        withBrokerContext(brokerIdA, async () => "a"),
        withBrokerContext(brokerIdB, async () => "b"),
      ]),
    ).resolves.toEqual(["a", "b"]);
  });

  it("does not throw for two independent sequential withBrokerContext calls with different broker ids", async () => {
    vi.doMock("../src/internal/client.js", () => {
      return {
        db: {
          transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx())),
        },
      };
    });

    const { withBrokerContext } = await import("../src/tenant.js");

    const brokerIdA = "123e4567-e89b-12d3-a456-426614174000";
    const brokerIdB = "223e4567-e89b-12d3-a456-426614174000";

    await expect(withBrokerContext(brokerIdA, async () => "a")).resolves.toBe("a");
    await expect(withBrokerContext(brokerIdB, async () => "b")).resolves.toBe("b");
  });
});
