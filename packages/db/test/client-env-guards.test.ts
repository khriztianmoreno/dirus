import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// design.md D-B: two connection URLs, each with hard-fail guards.
// - DATABASE_URL (pooled) is the runtime client's only allowed connection.
//   Missing -> throws at import. Non "-pooler" host -> throws unless
//   ALLOW_UNPOOLED_RUNTIME=1 (documented escape hatch).
describe("packages/db/src/internal/client.ts (design.md D-B: pooled runtime client)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("DATABASE_URL") || key === "ALLOW_UNPOOLED_RUNTIME") {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws at import when DATABASE_URL is missing", async () => {
    await expect(import("../src/internal/client.js")).rejects.toThrow(/DATABASE_URL/);
  });

  it("throws at import when DATABASE_URL host is not a pooled Neon endpoint", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@ep-cool-thing.us-east-2.aws.neon.tech/dirus";

    await expect(import("../src/internal/client.js")).rejects.toThrow(/-pooler/);
  });

  it("allows a non-pooled host when ALLOW_UNPOOLED_RUNTIME=1", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@ep-cool-thing.us-east-2.aws.neon.tech/dirus";
    process.env.ALLOW_UNPOOLED_RUNTIME = "1";

    await expect(import("../src/internal/client.js")).resolves.toBeDefined();
  });

  it("succeeds when DATABASE_URL points at a pooled endpoint", async () => {
    process.env.DATABASE_URL =
      "postgres://user:pass@ep-cool-thing-pooler.us-east-2.aws.neon.tech/dirus";

    const mod = await import("../src/internal/client.js");
    expect(mod.db).toBeDefined();
    expect(mod.pool).toBeDefined();
  });
});

// design.md D-B / D-G: the unpooled URL is for migrations/DDL only, and must
// itself NOT be a pooled endpoint (DDL must never cross PgBouncer).
describe("packages/db/src/internal/admin.ts (design.md D-B/D-G: unpooled admin client)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("DATABASE_URL") || key === "ALLOW_UNPOOLED_RUNTIME") {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws at import when DATABASE_URL_UNPOOLED is missing", async () => {
    await expect(import("../src/internal/admin.js")).rejects.toThrow(/DATABASE_URL_UNPOOLED/);
  });

  it("throws at import when DATABASE_URL_UNPOOLED host is a pooled endpoint", async () => {
    process.env.DATABASE_URL_UNPOOLED =
      "postgres://user:pass@ep-cool-thing-pooler.us-east-2.aws.neon.tech/dirus";

    await expect(import("../src/internal/admin.js")).rejects.toThrow(/-pooler/);
  });

  it("succeeds when DATABASE_URL_UNPOOLED points at a direct endpoint", async () => {
    process.env.DATABASE_URL_UNPOOLED =
      "postgres://user:pass@ep-cool-thing.us-east-2.aws.neon.tech/dirus";

    const mod = await import("../src/internal/admin.js");
    expect(mod.unsafeAdminDb).toBeDefined();
  });
});
