/**
 * Minimal typed Chatwoot client (design D-5, "packages/integrations/src/chatwoot.ts
 * — a minimal typed client: send one text reply"). Sends exactly one text
 * message back into a Chatwoot conversation — the fixed acknowledgement
 * reply (spec "Fixed Echo Reply" / proposal P1). Nothing else: no read
 * operations, no other Chatwoot API surface.
 */

/**
 * The fixed Spanish acknowledgement copy (proposal P1). A placeholder
 * pending the real agent (A2/B2) — it MUST NOT promise a specific
 * resolution or timeframe beyond acknowledging receipt, and it MUST NOT be
 * derived from (or overlap with) the customer's own message text (spec
 * "Reply is a fixed acknowledgement, not the customer's text").
 */
export const FIXED_ACKNOWLEDGEMENT_REPLY =
  "Gracias por tu mensaje. Lo hemos recibido y en breve un asesor te contactará.";

export type ChatwootClientConfig = {
  baseUrl: string;
  apiAccessToken: string;
  accountId: string;
};

export type SendReplyParams = {
  conversationId: number;
  content: string;
};

export type ChatwootClient = {
  sendReply(params: SendReplyParams): Promise<void>;
};

/**
 * Creates a client bound to one Chatwoot account (design D-5's file layout:
 * `packages/integrations/src/chatwoot.ts`). Only `index.ts` (the bootstrap)
 * constructs a real one; the ingest route accepts an injected `sendEcho`
 * function instead of this client directly, keeping `apps/api/src/app.ts`
 * offline-testable (design D-5) — see `apps/api/src/app.ts`'s
 * `CreateAppOptions.sendEcho`.
 */
export function createChatwootClient(config: ChatwootClientConfig): ChatwootClient {
  return {
    async sendReply({ conversationId, content }: SendReplyParams): Promise<void> {
      const url = `${config.baseUrl}/api/v1/accounts/${config.accountId}/conversations/${conversationId}/messages`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          api_access_token: config.apiAccessToken,
        },
        body: JSON.stringify({ content, message_type: "outgoing" }),
      });

      if (!res.ok) {
        throw new Error(
          `Chatwoot reply failed: ${res.status} ${res.statusText} (conversation ${conversationId})`,
        );
      }
    },
  };
}
