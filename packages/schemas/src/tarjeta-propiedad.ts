import { z } from "zod";
import { colombianDocTypeSchema, colombianPlateSchema, fullNameSchema } from "./primitives.js";

/**
 * NEEDS CONFIRMATION (no repo precedent): `ownerDocNumber` shape depends on
 * `ownerDocType` — a Colombian document number is not one shape. CC and TI
 * mirror the cédula digit range (`cedulaNumberSchema`, 6-10 digits). CE
 * (cédula de extranjería) is widened to 12 digits because foreign-national
 * ID numbers are not reliably bounded at 10. NIT (company/tax ID) allows an
 * optional hyphenated single verification digit (e.g. `900123456-7`), the
 * conventional printed format. PA (passport) is alphanumeric per ICAO
 * passport number conventions, not digits-only (e.g. `AB123456`). When
 * `ownerDocType` is absent, the CC pattern is used as the default — this
 * matches the schema's behavior before per-type validation existed and
 * keeps the common case (no type specified, presumed cédula) unchanged.
 */
const OWNER_DOC_NUMBER_PATTERNS: Record<z.infer<typeof colombianDocTypeSchema>, RegExp> = {
  CC: /^\d{6,10}$/,
  TI: /^\d{6,11}$/,
  CE: /^\d{6,12}$/,
  NIT: /^\d{6,10}(-\d)?$/,
  PA: /^[A-Za-z0-9]{6,12}$/,
};

/**
 * Tarjeta de propiedad (vehicle registration card) -> feeds the vehicle
 * side of a policy (`policies.plate`) plus the owner side of a `contacts`
 * upsert (ownerFullName, ownerDocNumber, ownerDocType). Real cards also
 * print make, model, year, engine number and chassis number; none of
 * those has a destination column in `packages/db` today (only
 * `policies.plate` exists for vehicle data), so they are deliberately
 * excluded here rather than inventing a column — see the apply report for
 * this change.
 *
 * `ownerDocNumber` format is validated against `ownerDocType` via
 * `superRefine` rather than a single fixed regex — see
 * `OWNER_DOC_NUMBER_PATTERNS` above. A single cédula-shaped regex applied
 * regardless of `docType` rejected valid PA/NIT/CE owner numbers, which
 * escalates Flash -> Pro on correctly-extracted data (the exact anti-pattern
 * `primitives.ts` warns against).
 */
export const tarjetaPropiedadSchema = z
  .object({
    plate: colombianPlateSchema.optional(),
    ownerFullName: fullNameSchema.optional(),
    ownerDocNumber: z.string().trim().optional(),
    ownerDocType: colombianDocTypeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.ownerDocNumber) return;
    const docType = value.ownerDocType ?? "CC";
    const pattern = OWNER_DOC_NUMBER_PATTERNS[docType];
    if (!pattern.test(value.ownerDocNumber)) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid owner document number for docType ${docType}`,
        path: ["ownerDocNumber"],
      });
    }
  });

export type TarjetaPropiedad = z.infer<typeof tarjetaPropiedadSchema>;
