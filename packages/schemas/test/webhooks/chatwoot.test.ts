import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ChatwootMessageCreatedPayload,
  chatwootMessageCreatedPayloadSchema,
  chatwootWebhookEnvelopeSchema,
  extractResolutionKey,
  isIgnorableChatwootEvent,
} from "../../src/webhooks/chatwoot.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/chatwoot-message-created.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Record<string, unknown>;

describe("chatwootWebhookEnvelopeSchema (stage 1 — design D-6, cheap discard before stage 2)", () => {
  it("parses the fixture's envelope (event + message_type present)", () => {
    const result = chatwootWebhookEnvelopeSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("lets the caller cheaply identify a non-message_created event as ignorable, without stage-2 parsing", () => {
    const envelope = chatwootWebhookEnvelopeSchema.parse({
      event: "conversation_status_changed",
    });
    expect(isIgnorableChatwootEvent(envelope)).toBe(true);
  });

  it("lets the caller identify a message_created event whose message_type is not incoming as ignorable", () => {
    const envelope = chatwootWebhookEnvelopeSchema.parse({
      event: "message_created",
      message_type: "outgoing",
    });
    expect(isIgnorableChatwootEvent(envelope)).toBe(true);
  });

  it("identifies the fixture's own event (message_created / incoming) as NOT ignorable", () => {
    const envelope = chatwootWebhookEnvelopeSchema.parse(fixture);
    expect(isIgnorableChatwootEvent(envelope)).toBe(false);
  });

  it("is non-strict: an envelope-only parse of a much larger payload still succeeds (cheap discard does not require the full shape)", () => {
    const result = chatwootWebhookEnvelopeSchema.safeParse({
      event: "message_created",
      message_type: "incoming",
      anything_else_chatwoot_might_send: { deeply: { nested: true } },
    });
    expect(result.success).toBe(true);
  });
});

describe("chatwootMessageCreatedPayloadSchema (stage 2 — strict-by-omission, .passthrough() forbidden, spec 'Raw Payload Is Not Retained Verbatim')", () => {
  it("parses the real captured fixture in full", () => {
    const result = chatwootMessageCreatedPayloadSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("strips a key the schema does not model — the fixture's own nested Chatwoot-internal fields never survive parsing", () => {
    const result = chatwootMessageCreatedPayloadSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("additional_attributes");
      expect(result.data).not.toHaveProperty("private");
      expect(result.data).not.toHaveProperty("created_at");
    }
  });

  it("strips an arbitrary extra Chatwoot-internal field not modeled by the schema", () => {
    const withExtraField = { ...fixture, private_note_id: 999, csat_survey_response: null };
    const result = chatwootMessageCreatedPayloadSchema.safeParse(withExtraField);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("private_note_id");
      expect(result.data).not.toHaveProperty("csat_survey_response");
    }
  });

  it("rejects a malformed payload missing a required field (sender)", () => {
    const withoutSender = { ...fixture };
    delete withoutSender.sender;
    const result = chatwootMessageCreatedPayloadSchema.safeParse(withoutSender);
    expect(result.success).toBe(false);
  });

  it("rejects a malformed payload missing conversation.id", () => {
    const malformed = { ...fixture, conversation: {} };
    const result = chatwootMessageCreatedPayloadSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("rejects an event that is not message_created", () => {
    const malformed = { ...fixture, event: "message_updated" };
    const result = chatwootMessageCreatedPayloadSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("rejects the old invented shape as a valid key source: an inbox carrying phone_number does not survive parsing (Success Criterion 2)", () => {
    const oldShaped = {
      ...fixture,
      inbox: { ...(fixture.inbox as Record<string, unknown>), phone_number: "+573009998877" },
    };
    const result = chatwootMessageCreatedPayloadSchema.safeParse(oldShaped);
    expect(result.success).toBe(true);
    if (result.success) {
      // The field is silently stripped, not preserved — reading it off the
      // parsed result is a type/runtime miss, so it can never again be used
      // as a resolution key source.
      expect(result.data.inbox).not.toHaveProperty("phone_number");
    }
  });

  it("rejects a payload built to require a top-level contact object as its own required field (contact is not modeled at all)", () => {
    const contactShaped = {
      ...fixture,
      contact: { id: 45, name: "Someone", phone_number: "+573001234567" },
    };
    const result = chatwootMessageCreatedPayloadSchema.safeParse(contactShaped);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("contact");
    }
  });
});

describe("extractResolutionKey() — design D-B: number | null, never throws, int4 boundary guard", () => {
  const parsedFixture = chatwootMessageCreatedPayloadSchema.parse(fixture);

  it("returns the number for a well-formed account.id (the real fixture)", () => {
    expect(extractResolutionKey(parsedFixture)).toBe(parsedFixture.account.id);
    expect(typeof extractResolutionKey(parsedFixture)).toBe("number");
  });

  it("returns the number 42 for a well-formed account.id = 42", () => {
    const payload = { ...parsedFixture, account: { ...parsedFixture.account, id: 42 } };
    expect(extractResolutionKey(payload)).toBe(42);
  });

  it.each([
    ["account is missing", { ...parsedFixture, account: undefined }],
    [
      "account.id is missing",
      { ...parsedFixture, account: { name: parsedFixture.account.name } },
    ],
    ["account.id is null", { ...parsedFixture, account: { ...parsedFixture.account, id: null } }],
    [
      "account.id is a string",
      { ...parsedFixture, account: { ...parsedFixture.account, id: "42" } },
    ],
  ])("returns null, never throws, when %s", (_label, payload) => {
    expect(() =>
      extractResolutionKey(payload as unknown as ChatwootMessageCreatedPayload),
    ).not.toThrow();
    expect(extractResolutionKey(payload as unknown as ChatwootMessageCreatedPayload)).toBeNull();
  });

  it.each([
    ["exceeds the int4 upper bound", 2_147_483_648],
    ["is negative", -1],
    ["is zero", 0],
    ["is fractional", 1.5],
  ])("refuses an account.id that %s — returns null, no query-layer code reachable", (_label, id) => {
    const payload = { ...parsedFixture, account: { ...parsedFixture.account, id } };
    expect(extractResolutionKey(payload)).toBeNull();
  });
});

describe("chatwoot.ts docstring — confirmed against a real captured payload (F2.1 design D-A, closes F2 task 4.8 / O4)", () => {
  it("the module docstring records the real capture, not a provisional/docs-derived marker", () => {
    const sourcePath = fileURLToPath(new URL("../../src/webhooks/chatwoot.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).not.toMatch(/@provisional/);
    expect(source).toMatch(/Confirmed against a real captured payload/);
  });
});
