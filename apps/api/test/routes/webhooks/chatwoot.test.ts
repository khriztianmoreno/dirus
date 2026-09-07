import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../src/app.js";

/**
 * Task 5.8/5.9 (design D-6, D-2/D-3/D-5): the full route, offline-tested
 * through `createApp` with fakes for `ingest`, `resolveBrokerId`, and
 * `sendEcho` (design D-5) — zero `@dirus/db` import reachable from this
 * file's import graph.
 *
 * Ordering per design's Technical Approach ("authenticate → parse → resolve
 * tenant → transaction → commit → echo"): auth → stage-1 envelope parse →
 * (ignored → 200, no db) → stage-2 payload parse → (invalid → 400) →
 * extractResolutionKey → tenant resolve → (unknown → reject, no db write)
 * → ingest → (success, not deduplicated → echo) / (deduplicated → no echo).
 */
const WEBHOOK_TOKEN = "t".repeat(32);

function fixturePayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "message_created",
    id: 1,
    content: "Hola, necesito una cotización",
    message_type: "incoming",
    content_type: "text",
    source_id: "wamid.abc123",
    sender: { id: 1, name: "Test", phone_number: "+573000000001" },
    contact: { id: 1, name: "Test", phone_number: "+573000000001" },
    conversation: { id: 55 },
    account: { id: 7, name: "Test Account" },
    inbox: { id: 12, name: "Test Inbox", phone_number: "phoneA" },
    ...overrides,
  };
}

function buildApp(opts: {
  ingest?: ReturnType<typeof vi.fn>;
  resolveBrokerId?: ReturnType<typeof vi.fn>;
  sendEcho?: ReturnType<typeof vi.fn>;
}) {
  const ingest = opts.ingest ?? vi.fn(async () => ({ deduplicated: false }));
  const resolveBrokerId = opts.resolveBrokerId ?? vi.fn(async () => "broker-1");
  const sendEcho = opts.sendEcho ?? vi.fn(async () => undefined);

  const app = createApp({
    ingest,
    resolveBrokerId,
    webhookToken: WEBHOOK_TOKEN,
    sendEcho,
    adminToken: "a".repeat(32),
    resolveBrokerExists: vi.fn(async () => true),
    importPolicyRows: vi.fn(async (brokerId: string) => ({
      brokerId,
      totals: { rows: 0, inserted: 0, updated: 0, failed: 0 },
      rows: [],
    })),
    resolveBrokerIdByEmail: vi.fn(async () => null),
    issueMagicLinkToken: vi.fn(async () => undefined),
    sendMagicLink: vi.fn(async () => undefined),
    dashboardBaseUrl: "https://app.dirus.io",
    resolveBrokerIdByMagicLinkTokenHash: vi.fn(async () => null),
    consumeMagicLinkToken: vi.fn(async () => ({ ok: false as const })),
    createSession: vi.fn(async () => ({ rawSessionToken: "s".repeat(43), rawCsrfToken: "c".repeat(43) })),
    resolveSession: vi.fn(async () => null),
    revokeSession: vi.fn(async () => undefined),
    needsReviewQueue: vi.fn(async () => []),
    correctExtraction: vi.fn(async () => ({ found: true })),
  });
  return { app, ingest, resolveBrokerId, sendEcho };
}

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/webhooks/chatwoot", {
    method: "POST",
    headers: { "X-Dirus-Webhook-Token": WEBHOOK_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /webhooks/chatwoot (design D-6 stage-1/2, D-5 wiring)", () => {
  it("a non-message_created event is ignored: 200 {ignored:true}, no ingest call at all", async () => {
    const { app, ingest, resolveBrokerId } = buildApp({});

    const res = await post(app, { event: "conversation_status_changed" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true });
    expect(ingest).not.toHaveBeenCalled();
    expect(resolveBrokerId).not.toHaveBeenCalled();
  });

  it("an incoming message_created event with an unresolvable wa_phone_number_id is rejected, ingest never called", async () => {
    const resolveBrokerId = vi.fn(async () => null);
    const { app, ingest } = buildApp({ resolveBrokerId });

    const res = await post(app, fixturePayload());

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("a malformed message_created payload (missing sender) is rejected with 400, ingest never called", async () => {
    const payload = fixturePayload();
    delete (payload as Record<string, unknown>).sender;
    const { app, ingest } = buildApp({});

    const res = await post(app, payload);

    expect(res.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("a valid incoming message calls ingest(brokerId, payload) and sends the echo when not deduplicated", async () => {
    const resolveBrokerId = vi.fn(async () => "broker-42");
    const ingest = vi.fn(async () => ({ deduplicated: false }));
    const sendEcho = vi.fn(async () => undefined);
    const { app } = buildApp({ resolveBrokerId, ingest, sendEcho });

    const res = await post(app, fixturePayload());

    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0]).toBe("broker-42");
    expect(sendEcho).toHaveBeenCalledTimes(1);
  });

  it("does NOT send the echo when ingest reports {deduplicated:true} (design D-3's losing side)", async () => {
    const ingest = vi.fn(async () => ({ deduplicated: true }));
    const sendEcho = vi.fn(async () => undefined);
    const { app } = buildApp({ ingest, sendEcho });

    const res = await post(app, fixturePayload());

    expect(res.status).toBe(200);
    expect(sendEcho).not.toHaveBeenCalled();
  });

  it("does NOT send the echo when ingest (persistence) throws/rejects (spec: Reply is not sent when persistence fails)", async () => {
    const ingest = vi.fn(async () => {
      throw new Error("persistence failed");
    });
    const sendEcho = vi.fn(async () => undefined);
    const { app } = buildApp({ ingest, sendEcho });

    const res = await post(app, fixturePayload());

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(sendEcho).not.toHaveBeenCalled();
  });

  it("rejects a request with no auth token before ever calling resolveBrokerId or ingest", async () => {
    const { app, ingest, resolveBrokerId } = buildApp({});

    const res = await app.request("/webhooks/chatwoot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fixturePayload()),
    });

    expect(res.status).toBe(401);
    expect(resolveBrokerId).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});
