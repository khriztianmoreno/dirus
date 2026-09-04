import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";

/**
 * design.md D-7: `resolveBrokerIdByWaPhoneNumberId` is a single statement on
 * the pooled client — no transaction, no `withBrokerContext`. These tests
 * run fully offline against a mocked `./internal/client.js`, mirroring
 * `tenant.test.ts`'s `vi.doMock` convention (never a live database).
 */
describe("resolveBrokerIdByWaPhoneNumberId (design.md D-7)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Task 2.2 (tasks.md): the length cap must reject pathological input
  // BEFORE any query runs — asserted here by a spy on the mocked `db.execute`
  // that must never be called.
  it("rejects input longer than the length cap before issuing any query", async () => {
    const executeSpy = vi.fn();
    vi.doMock("../src/internal/client.js", () => ({
      db: { execute: executeSpy },
    }));

    const { resolveBrokerIdByWaPhoneNumberId } = await import("../src/tenant-resolution.js");

    const pathologicalKey = "a".repeat(257);

    await expect(resolveBrokerIdByWaPhoneNumberId(pathologicalKey)).rejects.toThrow(
      /length/i,
    );
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("accepts a key at exactly the length cap and issues the query", async () => {
    const executeSpy = vi.fn(async () => ({
      rows: [{ dirus_resolve_broker_id: null }],
    }));
    vi.doMock("../src/internal/client.js", () => ({
      db: { execute: executeSpy },
    }));

    const { resolveBrokerIdByWaPhoneNumberId } = await import("../src/tenant-resolution.js");

    const boundaryKey = "a".repeat(256);
    await expect(resolveBrokerIdByWaPhoneNumberId(boundaryKey)).resolves.toBeNull();
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("issues a single statement calling public.dirus_resolve_broker_id with the key as a bound parameter, no transaction", async () => {
    const executeSpy = vi.fn<
      (query: SQL) => Promise<{ rows: { dirus_resolve_broker_id: string }[] }>
    >(async () => ({
      rows: [{ dirus_resolve_broker_id: "123e4567-e89b-12d3-a456-426614174000" }],
    }));
    const transactionSpy = vi.fn();
    vi.doMock("../src/internal/client.js", () => ({
      db: { execute: executeSpy, transaction: transactionSpy },
    }));

    const { resolveBrokerIdByWaPhoneNumberId } = await import("../src/tenant-resolution.js");

    const result = await resolveBrokerIdByWaPhoneNumberId("phoneA");

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
    expect(params).toEqual(["phoneA"]);
  });

  it("returns null when the resolver function reports an unknown key (no row content is exposed)", async () => {
    vi.doMock("../src/internal/client.js", () => ({
      db: {
        execute: vi.fn(async () => ({
          rows: [{ dirus_resolve_broker_id: null }],
        })),
      },
    }));

    const { resolveBrokerIdByWaPhoneNumberId } = await import("../src/tenant-resolution.js");

    await expect(resolveBrokerIdByWaPhoneNumberId("unknown")).resolves.toBeNull();
  });

  // Task 2.6 (tasks.md): resolveBrokerIdByWaPhoneNumberId must never open a
  // `withBrokerContext` transaction and must never return a table handle or
  // row object — its return type is `string | null`, full stop.
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

    const { resolveBrokerIdByWaPhoneNumberId } = await import("../src/tenant-resolution.js");

    const result = await resolveBrokerIdByWaPhoneNumberId("phoneB");

    expect(transactionSpy).not.toHaveBeenCalled();
    expect(typeof result === "string" || result === null).toBe(true);
    expect(result).not.toBeInstanceOf(Object);
  });
});
