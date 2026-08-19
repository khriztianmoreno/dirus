import { z } from "zod";
import { cedulaNumberSchema, colombianDocTypeSchema, colombianPlateSchema, fullNameSchema } from "./primitives.js";

/**
 * Tarjeta de propiedad (vehicle registration card) -> feeds the vehicle
 * side of a policy (`policies.plate`) plus the owner side of a `contacts`
 * upsert (ownerFullName, ownerDocNumber, ownerDocType). Real cards also
 * print make, model, year, engine number and chassis number; none of
 * those has a destination column in `packages/db` today (only
 * `policies.plate` exists for vehicle data), so they are deliberately
 * excluded here rather than inventing a column — see the apply report for
 * this change.
 */
export const tarjetaPropiedadSchema = z.object({
  plate: colombianPlateSchema.optional(),
  ownerFullName: fullNameSchema.optional(),
  ownerDocNumber: cedulaNumberSchema.optional(),
  ownerDocType: colombianDocTypeSchema.optional(),
});

export type TarjetaPropiedad = z.infer<typeof tarjetaPropiedadSchema>;
