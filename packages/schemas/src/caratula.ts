import { z } from "zod";
import {
  cedulaNumberSchema,
  colombianPlateSchema,
  copAmountSchema,
  copCurrencySchema,
  fullNameSchema,
  insurerLineSchema,
  insurerNameSchema,
  isoDateSchema,
} from "./primitives.js";

/**
 * Carátula (policy cover page) -> feeds `policies` (insurer, line,
 * policyNumber, plate, premiumAmount, currency, startDate, endDate) plus
 * the policyholder side of a `contacts` upsert (insuredFullName,
 * insuredDocNumber). Every field is optional on presence: a real cover
 * page photo rarely has every field legible. See primitives.ts for the
 * "optional on presence, strict on shape" rationale.
 */
export const caratulaSchema = z
  .object({
    insurer: insurerNameSchema.optional(),
    line: insurerLineSchema.optional(),
    policyNumber: z.string().trim().min(1).optional(),
    plate: colombianPlateSchema.optional(),
    premiumAmount: copAmountSchema.optional(),
    currency: copCurrencySchema.optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    insuredFullName: fullNameSchema.optional(),
    insuredDocNumber: cedulaNumberSchema.optional(),
  })
  .refine((value) => !value.startDate || !value.endDate || value.endDate >= value.startDate, {
    message: "endDate must not be before startDate",
    path: ["endDate"],
  });

export type Caratula = z.infer<typeof caratulaSchema>;
