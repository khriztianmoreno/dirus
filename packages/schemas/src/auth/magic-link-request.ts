import { z } from "zod";
import { emailSchema } from "../primitives.js";

/**
 * `POST /auth/magic-link` request body (`admin-dashboard` (C1) design.md
 * D-C, task 3.4). This schema validates SHAPE only — whether the email
 * matches a `broker_users` row is resolved downstream by the route (task
 * 3.6+, `resolveBrokerIdByEmail`), never here. Keeping "is this an email"
 * and "does this email exist" in two separate steps is what lets the route
 * return the identical response for both a well-formed-unknown and a
 * known email (broker-auth spec "Anti-Enumeration Response Is
 * Indistinguishable").
 */
export const magicLinkRequestSchema = z.object({
  email: emailSchema,
});

export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;
