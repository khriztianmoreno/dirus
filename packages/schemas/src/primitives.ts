import { z } from "zod";

/**
 * Colombian extraction primitives shared by the caratula, cedula and
 * tarjeta_propiedad schemas (docs/ARCHITECTURE.md line 369: nombre,
 * cédula, placa, vigencia, aseguradora are the load-bearing precision/
 * recall fields for H3).
 *
 * Design rule (project-wide for this package): optional on presence,
 * strict on shape. B2 (ingestion-agent) escalates Gemini Flash -> Pro on a
 * Zod validation failure. A field marked required but genuinely absent or
 * illegible on a real document turns every such photo into an escalation
 * — an expensive, misdiagnosed "model failure" that is actually a schema
 * bug. A field that IS present must still be well-formed; these
 * primitives reject malformed values, they never demand a complete
 * document.
 */

// NEEDS CONFIRMATION (no repo precedent): current Colombian plates are 3
// letters + 3 digits for cars (e.g. ABC123) or 3 letters + 2 digits + 1
// letter for motorcycles (e.g. ABC12D). Verify against the golden dataset
// once collected (ingestion-agent, B2) — this is the format a real
// document is most likely to disprove first.
export const colombianPlateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}\d{2}[A-Z0-9]$/, "Invalid Colombian plate format");

// NEEDS CONFIRMATION (no repo precedent): cédula de ciudadanía numbers are
// digits only, historically as short as 6 digits and up to 10 digits for
// numbers issued since ~2022. No punctuation (dots/dashes) is accepted —
// extraction should normalize before validation.
export const cedulaNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{6,10}$/, "Invalid cédula number");

// NEEDS CONFIRMATION (no repo precedent): the doc_type values a contact
// can hold. CC is the only value the "cedula" doc_class can ever produce;
// CE/TI/NIT/PA are kept for the tarjeta_propiedad owner field, which may
// belong to a foreign national, a minor, or a company-owned fleet.
export const colombianDocTypeSchema = z.enum(["CC", "CE", "TI", "NIT", "PA"]);

// ISO-8601 calendar date (YYYY-MM-DD), matching drizzle's `date` column
// type (policies.startDate / policies.endDate). Rejects impossible
// calendar dates (e.g. 2026-02-30), not just the regex shape.
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO-8601 date (YYYY-MM-DD)")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "Not a real calendar date");

// NEEDS CONFIRMATION (no repo precedent): COP is the only currency
// docs/ARCHITECTURE.md mentions (policies.currency defaults to "COP");
// kept as a closed literal until a second currency is confirmed against
// real documents.
export const copCurrencySchema = z.literal("COP");

// Matches numeric(14,2) (policies.premiumAmount): up to 12 integer
// digits, optional 2 decimal places, represented as a decimal string
// (not a JS number) to avoid floating-point rounding — mirrors how
// drizzle numeric columns are typically passed.
export const copAmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "Expected a decimal amount with up to 2 decimal places");

// NEEDS CONFIRMATION (no repo precedent): a plausible phone shape, not a
// strict E.164 validator. `contacts.phone` (§7.1) is `text NOT NULL` with
// no format constraint at the schema level — F2's webhook ingress passes
// through whatever Chatwoot's `contact.phone_number` already is (typically
// E.164, e.g. "+573001234567"). Accepts an optional leading `+` followed by
// 7-15 digits (E.164's own maximum length), which rejects obvious garbage
// ("not-a-phone", too-short fragments) without hard-coding Colombia-only
// assumptions a broker's spreadsheet may not follow.
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?\d{7,15}$/, "Invalid phone number");

// Matches numeric(5,2) (policies.commissionPct): up to 3 integer digits,
// optional 2 decimal places, same decimal-string rationale as
// copAmountSchema above.
export const commissionPctSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "Expected a decimal percentage with up to 2 decimal places");

// policies.line is a closed set per docs/ARCHITECTURE.md line 255.
export const insurerLineSchema = z.enum(["auto", "vida", "hogar", "salud", "soat"]);

// Free text, not a closed enum: docs/ARCHITECTURE.md line 255 lists Sura,
// Bolívar, Allianz as examples ("Sura, Bolívar, Allianz...") — not an
// exhaustive list of supported insurers.
export const insurerNameSchema = z.string().trim().min(2, "Insurer name too short");

export const fullNameSchema = z.string().trim().min(2, "Name too short");

/**
 * `admin-dashboard` (C1) design.md D-A/D-H: `broker_users.email` and the
 * magic-link request body's `email` field both validate against this
 * schema. Zod's built-in `.email()` (RFC 5321-adjacent, not a full RFC 5322
 * grammar) is intentionally the ONLY shape check here — anti-enumeration
 * (design D-C, broker-auth spec "Anti-Enumeration Response Is
 * Indistinguishable") depends on a malformed value being rejected the same
 * way regardless of whether it happens to resemble a real address, so this
 * schema does no normalization beyond `trim()` + `toLowerCase()` that could
 * itself become a second, subtly different oracle from the one the route
 * enforces.
 */
export const emailSchema = z.string().trim().toLowerCase().email("Invalid email address");
