import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chatwootMessageCreatedPayloadSchema,
  chatwootWebhookEnvelopeSchema,
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
  it("parses the fixture in full", () => {
    const result = chatwootMessageCreatedPayloadSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("strips a key the schema does not model — the fixture's own '_provisional' marker never survives parsing", () => {
    const result = chatwootMessageCreatedPayloadSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("_provisional");
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
});

describe("chatwoot.ts docstring — @provisional marker (design D-6, proposal O4 NEEDS CONFIRMATION)", () => {
  it("the module docstring itself carries an @provisional marker, not just an adjacent comment", () => {
    const sourcePath = fileURLToPath(new URL("../../src/webhooks/chatwoot.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).toMatch(/@provisional/);
  });
});
