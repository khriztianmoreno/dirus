import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `admin-dashboard` (C1) tasks.md Phase 2, design.md D-A: the three new
 * pre-tenant lookups (`resolveBrokerIdByEmail`,
 * `resolveBrokerIdByMagicLinkTokenHash`, `resolveBrokerIdBySessionTokenHash`)
 * mirror `tenant-resolution.test.ts`'s established offline convention
 * exactly — fully mocked `./internal/client.js`, never a live database. Each
 * is a single statement on the pooled client, no transaction, returning
 * `string | null` and nothing else (the same invariant
 * `resolveBrokerIdByWaPhoneNumberId` enforces, see `src/tenant.ts`'s
 * corrected `TenantDb` docstring, task 2.5).
 */
describe("auth-resolution.ts (design.md D-A, tasks.md Phase 2)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("resolveBrokerIdByEmail", () => {
    // Task 2.2: length cap is 254 — RFC 5321 §4.5.3.1.3's maximum total
    // length for a reverse-path/forward-path mailbox. Unlike the SHA-256
    // hashes below, an email is not fixed-length, so this cap reasons about
    // the realistic upper bound of the value's own shape (the standard's
    // stated maximum), not an arbitrary round number copied from another
    // function.
    it("rejects an email longer than 254 characters before issuing any query", async () => {
      const executeSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy },
      }));

      const { resolveBrokerIdByEmail } = await import("../src/auth-resolution.js");

      const pathologicalEmail = `${"a".repeat(250)}@example.com`; // 262 chars

      await expect(resolveBrokerIdByEmail(pathologicalEmail)).rejects.toThrow(/length/i);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("accepts an email at exactly the length cap and issues the query", async () => {
      const executeSpy = vi.fn(async () => ({
        rows: [{ dirus_resolve_broker_id_by_email: null }],
      }));
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy },
      }));

      const { resolveBrokerIdByEmail } = await import("../src/auth-resolution.js");

      const localPart = "a".repeat(254 - "@example.com".length);
      const boundaryEmail = `${localPart}@example.com`;
      expect(boundaryEmail).toHaveLength(254);

      await expect(resolveBrokerIdByEmail(boundaryEmail)).resolves.toBeNull();
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("issues a single statement calling public.dirus_resolve_broker_id_by_email, no transaction", async () => {
      const executeSpy = vi.fn(async () => ({
        rows: [{ dirus_resolve_broker_id_by_email: "123e4567-e89b-12d3-a456-426614174000" }],
      }));
      const transactionSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy, transaction: transactionSpy },
      }));

      const { resolveBrokerIdByEmail } = await import("../src/auth-resolution.js");

      const result = await resolveBrokerIdByEmail("alice@example.com");

      expect(result).toBe("123e4567-e89b-12d3-a456-426614174000");
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy).not.toHaveBeenCalled();
    });

    it("returns null when the resolver function reports an unknown email (no row content is exposed)", async () => {
      vi.doMock("../src/internal/client.js", () => ({
        db: {
          execute: vi.fn(async () => ({
            rows: [{ dirus_resolve_broker_id_by_email: null }],
          })),
        },
      }));

      const { resolveBrokerIdByEmail } = await import("../src/auth-resolution.js");

      await expect(resolveBrokerIdByEmail("unknown@example.com")).resolves.toBeNull();
    });
  });

  describe("resolveBrokerIdByMagicLinkTokenHash", () => {
    // Task 2.2: the length cap is exactly 64 — a SHA-256 digest hex-encoded
    // (`node:crypto`'s `.digest("hex")`, per design.md D-H) is ALWAYS 64
    // characters, unlike an email or a phone-number-id string. There is no
    // "realistic upper bound" to reason about here; the input is
    // fixed-length by construction, so anything longer is definitionally
    // pathological (or the caller hashed something other than SHA-256),
    // never a legitimate value that merely happens to be long.
    it("rejects a token hash longer than 64 characters before issuing any query", async () => {
      const executeSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy },
      }));

      const { resolveBrokerIdByMagicLinkTokenHash } = await import("../src/auth-resolution.js");

      await expect(resolveBrokerIdByMagicLinkTokenHash("a".repeat(65))).rejects.toThrow(/length/i);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("accepts a token hash at exactly 64 characters and issues the query", async () => {
      const executeSpy = vi.fn(async () => ({
        rows: [{ dirus_resolve_broker_id_by_magic_link: null }],
      }));
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy },
      }));

      const { resolveBrokerIdByMagicLinkTokenHash } = await import("../src/auth-resolution.js");

      await expect(resolveBrokerIdByMagicLinkTokenHash("a".repeat(64))).resolves.toBeNull();
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("issues a single statement calling public.dirus_resolve_broker_id_by_magic_link, no transaction", async () => {
      const executeSpy = vi.fn(async () => ({
        rows: [{ dirus_resolve_broker_id_by_magic_link: "223e4567-e89b-12d3-a456-426614174000" }],
      }));
      const transactionSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy, transaction: transactionSpy },
      }));

      const { resolveBrokerIdByMagicLinkTokenHash } = await import("../src/auth-resolution.js");

      const result = await resolveBrokerIdByMagicLinkTokenHash("b".repeat(64));

      expect(result).toBe("223e4567-e89b-12d3-a456-426614174000");
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy).not.toHaveBeenCalled();
    });

    it("returns null when the resolver function reports an unknown token hash", async () => {
      vi.doMock("../src/internal/client.js", () => ({
        db: {
          execute: vi.fn(async () => ({
            rows: [{ dirus_resolve_broker_id_by_magic_link: null }],
          })),
        },
      }));

      const { resolveBrokerIdByMagicLinkTokenHash } = await import("../src/auth-resolution.js");

      await expect(resolveBrokerIdByMagicLinkTokenHash("c".repeat(64))).resolves.toBeNull();
    });
  });

  describe("resolveBrokerIdBySessionTokenHash", () => {
    // Same reasoning as the magic-link hash above: SHA-256 hex is always 64
    // characters (design.md D-H — "Hashing is SHA-256 ... for both tables").
    it("rejects a session hash longer than 64 characters before issuing any query", async () => {
      const executeSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy },
      }));

      const { resolveBrokerIdBySessionTokenHash } = await import("../src/auth-resolution.js");

      await expect(resolveBrokerIdBySessionTokenHash("a".repeat(65))).rejects.toThrow(/length/i);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("accepts a session hash at exactly 64 characters and issues the query", async () => {
      const executeSpy = vi.fn(async () => ({
        rows: [{ dirus_resolve_broker_id_by_session: null }],
      }));
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy },
      }));

      const { resolveBrokerIdBySessionTokenHash } = await import("../src/auth-resolution.js");

      await expect(resolveBrokerIdBySessionTokenHash("a".repeat(64))).resolves.toBeNull();
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("issues a single statement calling public.dirus_resolve_broker_id_by_session, no transaction", async () => {
      const executeSpy = vi.fn(async () => ({
        rows: [{ dirus_resolve_broker_id_by_session: "323e4567-e89b-12d3-a456-426614174000" }],
      }));
      const transactionSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: { execute: executeSpy, transaction: transactionSpy },
      }));

      const { resolveBrokerIdBySessionTokenHash } = await import("../src/auth-resolution.js");

      const result = await resolveBrokerIdBySessionTokenHash("d".repeat(64));

      expect(result).toBe("323e4567-e89b-12d3-a456-426614174000");
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy).not.toHaveBeenCalled();
    });

    it("returns null when the resolver function reports an unknown session hash", async () => {
      vi.doMock("../src/internal/client.js", () => ({
        db: {
          execute: vi.fn(async () => ({
            rows: [{ dirus_resolve_broker_id_by_session: null }],
          })),
        },
      }));

      const { resolveBrokerIdBySessionTokenHash } = await import("../src/auth-resolution.js");

      await expect(resolveBrokerIdBySessionTokenHash("e".repeat(64))).resolves.toBeNull();
    });
  });

  // Task 2.6: mirrors `tenant-resolution.test.ts`'s identical convention for
  // `resolveBrokerIdByWaPhoneNumberId`. RED-before-GREEN is not attainable
  // in the ordinary sense for this property: each function's return TYPE
  // (`Promise<string | null>`) already makes returning a row/table handle a
  // compile-time error, so no runtime input can force a meaningful RED
  // state without first defeating the type system. Validated instead by
  // MUTATION TESTING: this assertion is run against the real implementation
  // (GREEN, expected) and the mutation performed manually (temporarily
  // returning `result.rows[0]` instead of the unwrapped column) is recorded
  // in apply-progress.md's Phase 2 section, along with its outcome.
  describe("task 2.6: none of the three functions opens a transaction or returns a row/table handle", () => {
    it("resolveBrokerIdByEmail never opens a transaction and returns only a primitive string-or-null (mutation-tested; see apply-progress.md)", async () => {
      const transactionSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: {
          execute: vi.fn(async () => ({
            rows: [{ dirus_resolve_broker_id_by_email: "423e4567-e89b-12d3-a456-426614174000" }],
          })),
          transaction: transactionSpy,
        },
      }));

      const { resolveBrokerIdByEmail } = await import("../src/auth-resolution.js");
      const result = await resolveBrokerIdByEmail("dana@example.com");

      expect(transactionSpy).not.toHaveBeenCalled();
      expect(typeof result === "string" || result === null).toBe(true);
      expect(result).not.toBeInstanceOf(Object);
    });

    it("resolveBrokerIdByMagicLinkTokenHash never opens a transaction and returns only a primitive string-or-null (mutation-tested; see apply-progress.md)", async () => {
      const transactionSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: {
          execute: vi.fn(async () => ({
            rows: [{ dirus_resolve_broker_id_by_magic_link: "523e4567-e89b-12d3-a456-426614174000" }],
          })),
          transaction: transactionSpy,
        },
      }));

      const { resolveBrokerIdByMagicLinkTokenHash } = await import("../src/auth-resolution.js");
      const result = await resolveBrokerIdByMagicLinkTokenHash("f".repeat(64));

      expect(transactionSpy).not.toHaveBeenCalled();
      expect(typeof result === "string" || result === null).toBe(true);
      expect(result).not.toBeInstanceOf(Object);
    });

    it("resolveBrokerIdBySessionTokenHash never opens a transaction and returns only a primitive string-or-null (mutation-tested; see apply-progress.md)", async () => {
      const transactionSpy = vi.fn();
      vi.doMock("../src/internal/client.js", () => ({
        db: {
          execute: vi.fn(async () => ({
            rows: [{ dirus_resolve_broker_id_by_session: "623e4567-e89b-12d3-a456-426614174000" }],
          })),
          transaction: transactionSpy,
        },
      }));

      const { resolveBrokerIdBySessionTokenHash } = await import("../src/auth-resolution.js");
      const result = await resolveBrokerIdBySessionTokenHash("0".repeat(64));

      expect(transactionSpy).not.toHaveBeenCalled();
      expect(typeof result === "string" || result === null).toBe(true);
      expect(result).not.toBeInstanceOf(Object);
    });
  });
});
