import { eq } from "drizzle-orm";
import { schema, withBrokerContext } from "@dirus/db";
import type { IssueMagicLinkTokenFn } from "../../routes/auth/magic-link.js";

/**
 * `admin-dashboard` (C1) task 3.11, design.md D-A/D-C: the real
 * "withBrokerContext(insert magic_link_tokens) (COMMIT)" step from
 * design.md's data-flow diagram. Opaque to `routes/auth/magic-link.ts`,
 * which only imports the `IssueMagicLinkTokenFn` TYPE from that route
 * module (never this file as a value) — only `apps/api/src/index.ts` wires
 * this real implementation in.
 *
 * `resolveBrokerIdByEmail` (design.md D-A) returns only a bare `broker_id`
 * — never a row, per that access class's own invariant. This function
 * independently resolves `broker_user_id` inside the SAME
 * `withBrokerContext(brokerId, ...)` transaction: the lookup runs with
 * `app.broker_id` already set to `brokerId`, so RLS scopes it to that
 * broker's own `broker_users` rows, and `email`'s plain global uniqueness
 * (design.md D-H) means at most one row can match regardless.
 */
export const issueMagicLinkToken: IssueMagicLinkTokenFn = async ({ brokerId, email, tokenHash, expiresAt }) => {
  await withBrokerContext(brokerId, async (tx) => {
    const [user] = await tx
      .select({ id: schema.brokerUsers.id })
      .from(schema.brokerUsers)
      .where(eq(schema.brokerUsers.email, email))
      .limit(1);

    if (!user) {
      // Should be unreachable: `resolveBrokerIdByEmail` (called
      // immediately before this, by the same route) just proved a
      // `broker_users` row with this email exists. Fail loud rather than
      // silently proceeding without a `broker_user_id`, matching this
      // codebase's stance elsewhere (e.g. `import-policies-writer.ts`
      // rethrows unexpected errors rather than absorbing them).
      throw new Error(`unexpected: no broker_users row found for email during magic-link issuance`);
    }

    await tx.insert(schema.magicLinkTokens).values({
      brokerId,
      brokerUserId: user.id,
      tokenHash,
      expiresAt,
    });
  });
};
