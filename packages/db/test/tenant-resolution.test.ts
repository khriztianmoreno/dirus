import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";

/**
 * design.md D-7/D-E (fix-chatwoot-tenant-resolution/F2.1):
 * `resolveBrokerIdByChatwootAccountId` (renamed from
 * `resolveBrokerIdByWaPhoneNumberId`, retyped from `string` to `number`) is
 * a single statement on the pooled client — no transaction, no
 * `withBrokerContext`. These tests run fully offline against a mocked
 * `./internal/client.js`, mirroring `tenant.test.ts`'s `vi.doMock`
 * convention (never a live database).
 */
describe("resolveBrokerIdByChatwootAccountId (design.md D-7/D-E)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // fix-chatwoot-tenant-resolution/F2.1 design.md D-E: the string
  // `MAX_KEY_LENGTH` cap is replaced by an int4-range guard on the numeric
  // `accountId` parameter, asserted here by a spy on the mocked
  // `db.execute` that must never be called for an out-of-range value.
  it.each([
    ["one above the int4 upper bound", 2_147_483_648],
    ["negative", -1],
    ["zero", 0],
    ["fractional", 1.5],
  ])("rejects %s accountId (%s) before issuing any query", async (_label, accountId) => {
    const executeSpy = vi.fn();
    vi.doMock("../src/internal/client.js", () => ({
      db: { execute: executeSpy },
    }));

    const { resolveBrokerIdByChatwootAccountId } = await import("../src/tenant-resolution.js");

    await expect(resolveBrokerIdByChatwootAccountId(accountId)).rejects.toThrow(
      /integer/i,
    );
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("accepts an accountId at the int4 upper bound and issues the query", async () => {
    const executeSpy = vi.fn(async () => ({
      rows: [{ dirus_resolve_broker_id: null }],
    }));
    vi.doMock("../src/internal/client.js", () => ({
      db: { execute: executeSpy },
    }));

    const { resolveBrokerIdByChatwootAccountId } = await import("../src/tenant-resolution.js");

    const boundaryAccountId = 2_147_483_647;
    await expect(resolveBrokerIdByChatwootAccountId(boundaryAccountId)).resolves.toBeNull();
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("issues a single statement calling public.dirus_resolve_broker_id with the accountId as a bound parameter, no transaction", async () => {
    const executeSpy = vi.fn<
      (query: SQL) => Promise<{ rows: { dirus_resolve_broker_id: string }[] }>
    >(async () => ({
      rows: [{ dirus_resolve_broker_id: "123e4567-e89b-12d3-a456-426614174000" }],
    }));
    const transactionSpy = vi.fn();
    vi.doMock("../src/internal/client.js", () => ({
      db: { execute: executeSpy, transaction: transactionSpy },
    }));

    const { resolveBrokerIdByChatwootAccountId } = await import("../src/tenant-resolution.js");

    const result = await resolveBrokerIdByChatwootAccountId(1001);

    expect(result).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy).not.toHaveBeenCalled();

    const [query] = executeSpy.mock.calls[0];
    const { sql: renderedSql, params } = query.toQuery({
      casing: new CasingCache(),
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (n: number) => `$${n + 1}`,
      escapeString: (str: string) => `'${str}'`,
    });

    expect(renderedSql).toContain("select public.dirus_resolve_broker_id(");
    expect(params).toEqual([1001]);
  });

  it("returns null when the resolver function reports an unknown key (no row content is exposed)", async () => {
    vi.doMock("../src/internal/client.js", () => ({
      db: {
        execute: vi.fn(async () => ({
          rows: [{ dirus_resolve_broker_id: null }],
        })),
      },
    }));

    const { resolveBrokerIdByChatwootAccountId } = await import("../src/tenant-resolution.js");

    await expect(resolveBrokerIdByChatwootAccountId(999999)).resolves.toBeNull();
  });

  // Task 2.6 (tasks.md): resolveBrokerIdByChatwootAccountId must never open
  // a `withBrokerContext` transaction and must never return a table handle
  // or row object — its return type is `string | null`, full stop.
  //
  // RED-before-GREEN is not attainable for this property in the ordinary
  // sense: the function's return TYPE (`Promise<string | null>`) already
  // makes returning a row object a compile-time error, so no runtime input
  // can force a meaningful RED state without first defeating the type
  // system. Per tasks.md 2.6, this is validated by MUTATION TESTING instead:
  // the assertions below (no transaction call, and the return value is
  // always a `string` or `null`, never an `object`) are run once against the
  // real implementation (GREEN, expected), and the "restore" step documents
  // the mutation performed manually and its outcome — see
  // apply-progress.md's Phase 2 section for the record of that mutation run.
  it("never opens a transaction and returns only a primitive string-or-null (mutation-tested; see apply-progress.md)", async () => {
    const transactionSpy = vi.fn();
    vi.doMock("../src/internal/client.js", () => ({
      db: {
        execute: vi.fn(async () => ({
          rows: [{ dirus_resolve_broker_id: "223e4567-e89b-12d3-a456-426614174000" }],
        })),
        transaction: transactionSpy,
      },
    }));

    const { resolveBrokerIdByChatwootAccountId } = await import("../src/tenant-resolution.js");

    const result = await resolveBrokerIdByChatwootAccountId(1002);

    expect(transactionSpy).not.toHaveBeenCalled();
    expect(typeof result === "string" || result === null).toBe(true);
    expect(result).not.toBeInstanceOf(Object);
  });
});
