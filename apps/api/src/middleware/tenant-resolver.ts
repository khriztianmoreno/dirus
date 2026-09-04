import type { MiddlewareHandler } from "hono";

export type ResolveBrokerId = (key: string) => Promise<string | null>;

export type TenantResolverVariables = {
  /** Set by an earlier step in the route from `extractResolutionKey` (design D-6). */
  resolutionKey: string;
  /** Set by this middleware on success — never guessed or defaulted. */
  brokerId: string;
};

/**
 * Design D-1/D-5: resolves `c.var.brokerId` from `c.var.resolutionKey`
 * (already extracted from the parsed payload via `extractResolutionKey`,
 * design D-6, by an earlier step in the route). NEVER guesses or defaults a
 * `brokerId` — an unknown key rejects outright and nothing downstream runs.
 *
 * Takes `resolveBrokerId` as an injected parameter (never imports
 * `@dirus/db` directly) so this middleware — and anything that mounts it —
 * stays offline-testable with a fake (design D-5). Only `apps/api/src/index.ts`
 * wires in the real `resolveBrokerIdByWaPhoneNumberId` export.
 */
export function createTenantResolverMiddleware(
  resolveBrokerId: ResolveBrokerId,
): MiddlewareHandler<{ Variables: TenantResolverVariables }> {
  return async (c, next) => {
    const key = c.var.resolutionKey;
    const brokerId = await resolveBrokerId(key);

    if (brokerId === null) {
      // Spec "Unknown wa_phone_number_id emits an operational log without
      // message content" / proposal P4: log ONLY the wa_phone_number_id —
      // never the message body, sender name, or any other payload field.
      // A single structured argument (not string concatenation with
      // anything else from the request) keeps that boundary mechanical,
      // not just a convention someone has to remember.
      console.error("tenant_resolution_miss", { wa_phone_number_id: key });
      return c.body(null, 404);
    }

    c.set("brokerId", brokerId);
    await next();
  };
}
