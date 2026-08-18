import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNotPooledHost,
  assertUnpooledUrlConfigured,
  smokeTestConnection,
} from "../scripts/migrate.js";

/**
 * design.md D-G: `pnpm db:migrate` runs three preflight guards, in order,
 * before ever touching the Drizzle migrator — (1) `DATABASE_URL_UNPOOLED`
 * must be present, (2) its host must not be a pooled Neon endpoint (DDL
 * must never cross a transaction pooler), (3) a bounded connectivity smoke
 * test (`SELECT 1`, 5s default timeout) must succeed. A bad URL must never
 * produce a partially applied migration, so every guard here is a pure,
 * independently testable function — none of them open a Drizzle instance
 * or touch `unsafeAdminDb`.
 */

describe("assertUnpooledUrlConfigured (design.md D-G, guard 1)", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws naming DATABASE_URL_UNPOOLED when it is missing", () => {
    delete process.env.DATABASE_URL_UNPOOLED;

    expect(() => assertUnpooledUrlConfigured()).toThrow(/DATABASE_URL_UNPOOLED/);
  });

  it("returns the URL when DATABASE_URL_UNPOOLED is set", () => {
    process.env.DATABASE_URL_UNPOOLED = "postgres://user:pass@ep-cool-thing.us-east-2.aws.neon.tech/dirus";

    expect(assertUnpooledUrlConfigured()).toBe(process.env.DATABASE_URL_UNPOOLED);
  });
});

describe("assertNotPooledHost (design.md D-G, guard 2)", () => {
  it("throws before DDL when the unpooled URL's host is a pooled Neon endpoint", () => {
    const url = "postgres://user:pass@ep-cool-thing-pooler.us-east-2.aws.neon.tech/dirus";

    expect(() => assertNotPooledHost(url)).toThrow(/-pooler/);
  });

  it("passes silently for a direct (non-pooled) host", () => {
    const url = "postgres://user:pass@ep-cool-thing.us-east-2.aws.neon.tech/dirus";

    expect(() => assertNotPooledHost(url)).not.toThrow();
  });

  // Security regression, same leak class as parse-host.ts's own guard: a
  // malformed URL must never have any part of itself echoed back.
  it("never leaks credentials from a malformed URL into the thrown error", () => {
    const url = "postgres://scott:tigersecret123@[invalid";

    try {
      assertNotPooledHost(url);
      expect.unreachable("expected assertNotPooledHost to throw on a malformed URL");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("scott");
      expect(message).not.toContain("tigersecret123");
    }
  });
});

describe("smokeTestConnection (design.md D-G, guard 3)", () => {
  let server: net.Server;
  let port: number;
  let sockets: net.Socket[];

  beforeEach(async () => {
    // A TCP server that accepts the connection but never sends a byte back
    // — simulates an unreachable Neon host that hangs instead of refusing
    // the connection outright, the exact case a bounded timeout exists for.
    sockets = [];
    server = net.createServer((socket) => {
      sockets.push(socket);
      /* deliberately never responds */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected server.address() to return an AddressInfo");
    }
    port = address.port;
  });

  afterEach(async () => {
    // `server.close()` only stops accepting new connections — it waits for
    // already-open sockets to close before its callback fires, and the
    // client under test may still hold one open (its own `.end()` races
    // against a connection that never finished the startup handshake). Force
    // them closed so this hook cannot itself hang.
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails as 'cannot connect to Neon: <host>' and bounds the wait instead of hanging forever", async () => {
    const url = `postgres://user:pass@127.0.0.1:${port}/dirus`;
    const start = Date.now();

    await expect(smokeTestConnection(url, 300)).rejects.toThrow(
      /cannot connect to Neon: 127\.0\.0\.1/,
    );

    const elapsed = Date.now() - start;
    // Generous upper bound (well over the 300ms timeout) so this stays
    // reliable under CI load, while still proving the guard did not hang
    // indefinitely waiting on a server that never responds.
    expect(elapsed).toBeLessThan(3000);
  });

  // Security regression: even the unreachable-host failure must never leak
  // any part of the raw connection string.
  it("never leaks credentials from the connection string on timeout", async () => {
    const url = `postgres://scott:tigersecret123@127.0.0.1:${port}/dirus`;

    try {
      await smokeTestConnection(url, 300);
      expect.unreachable("expected smokeTestConnection to reject");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("scott");
      expect(message).not.toContain("tigersecret123");
    }
  });
});
