import { z } from "zod";
import {
  cedulaNumberSchema,
  colombianDocTypeSchema,
  colombianPlateSchema,
  commissionPctSchema,
  copAmountSchema,
  copCurrencySchema,
  fullNameSchema,
  insurerLineSchema,
  insurerNameSchema,
  isoDateSchema,
  phoneSchema,
} from "./primitives.js";

/**
 * Policy bulk import row (`policy-bulk-import`, A1) -> feeds `policies`
 * (insurer, line, policyNumber, plate, premiumAmount, currency,
 * commissionPct, startDate, endDate) and a `contacts` find-or-create
 * (fullName, docType, docNumber, phone).
 *
 * **NEEDS CONFIRMATION (O1)**: the required/optional split below is
 * provisional pending a real broker spreadsheet. The only fields required
 * here are the schema's own `NOT NULL` columns — `insurer`, `line`,
 * `endDate`, and a contact `phone` (proposal O1, spec "Row Validation Is
 * Per-Row, Not Whole-File"). Every other recognized column is optional on
 * presence, strict on shape — see primitives.ts for the rationale.
 */
export const policyImportRowSchema = z.object({
  insurer: insurerNameSchema,
  line: insurerLineSchema,
  endDate: isoDateSchema,
  phone: phoneSchema,
  policyNumber: z.string().trim().min(1).optional(),
  plate: colombianPlateSchema.optional(),
  premiumAmount: copAmountSchema.optional(),
  currency: copCurrencySchema.optional(),
  commissionPct: commissionPctSchema.optional(),
  startDate: isoDateSchema.optional(),
  fullName: fullNameSchema.optional(),
  docType: colombianDocTypeSchema.optional(),
  docNumber: cedulaNumberSchema.optional(),
});

export type PolicyImportRow = z.infer<typeof policyImportRowSchema>;
