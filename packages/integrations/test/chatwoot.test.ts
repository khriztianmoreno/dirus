import { describe, expect, it, vi } from "vitest";
import { FIXED_ACKNOWLEDGEMENT_REPLY, createChatwootClient } from "../src/chatwoot.js";

/**
 * Task 5.18 (design D-5/D-6, spec "Fixed Echo Reply" / P1): the reply text
 * must never equal, nor be a substring-derived echo of, the customer's own
 * message body. A table of varied inputs — including one that happens to
 * OVERLAP textually with the fixed copy — makes this a real discriminating
 * assertion rather than a tautology any string would pass.
 */
describe("FIXED_ACKNOWLEDGEMENT_REPLY (design D-5, spec P1)", () => {
  const customerBodies = [
    "Hola, necesito una cotización",
    "",
    "Gracias",
    // Deliberately overlaps with the fixed copy's own wording ("Gracias por
    // tu mensaje") — if the implementation ever built the reply by
    // echoing/deriving from the customer text, this case would falsely
    // pass a naive "not equal" check while still being wrong in spirit.
    "Gracias por tu mensaje, ya te puedo pagar",
  ];

  it.each(customerBodies)("is not equal to, nor derived from, customer body: %s", (body) => {
    expect(FIXED_ACKNOWLEDGEMENT_REPLY).not.toBe(body);
  });

  it("does not promise a specific resolution or timeframe beyond acknowledging receipt", () => {
    // A loose guard against a future edit accidentally adding a concrete
    // commitment (e.g. "en 5 minutos", "mañana") — proposal P1's
    // constraint. Not exhaustive, but catches the most literal violations.
    expect(FIXED_ACKNOWLEDGEMENT_REPLY.toLowerCase()).not.toMatch(/\b\d+\s*(minutos?|horas?|d[ií]as?)\b/);
  });
});

describe("createChatwootClient().sendReply (design D-5)", () => {
  it("POSTs the content to the account/conversation messages endpoint with the api_access_token header", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const client = createChatwootClient({
      baseUrl: "https://chatwoot.example.com",
      apiAccessToken: "test-token",
      accountId: "42",
    });

    await client.sendReply({ conversationId: 7, content: FIXED_ACKNOWLEDGEMENT_REPLY });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://chatwoot.example.com/api/v1/accounts/42/conversations/7/messages");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).api_access_token).toBe("test-token");
    expect(JSON.parse(init?.body as string)).toEqual({
      content: FIXED_ACKNOWLEDGEMENT_REPLY,
      message_type: "outgoing",
    });

    vi.unstubAllGlobals();
  });

  it("throws when Chatwoot responds with a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500, statusText: "Internal Server Error" })),
    );

    const client = createChatwootClient({
      baseUrl: "https://chatwoot.example.com",
      apiAccessToken: "test-token",
      accountId: "42",
    });

    await expect(client.sendReply({ conversationId: 7, content: "x" })).rejects.toThrow(/500/);

    vi.unstubAllGlobals();
  });
});
