import { z } from "zod";
import { cedulaNumberSchema, fullNameSchema } from "./primitives.js";

/**
 * Cédula (Colombian national ID card) -> feeds `contacts` (fullName,
 * docType, docNumber). docType is fixed to "CC" because the "cedula"
 * doc_class always identifies a cédula de ciudadanía; CE/TI/NIT/PA never
 * come from this document (they belong to tarjeta_propiedad's owner
 * field). Optional on presence: photos of a physical card commonly clip
 * a corner or blur the printed number.
 */
export const cedulaSchema = z.object({
  fullName: fullNameSchema.optional(),
  docType: z.literal("CC").optional(),
  docNumber: cedulaNumberSchema.optional(),
});

export type Cedula = z.infer<typeof cedulaSchema>;
