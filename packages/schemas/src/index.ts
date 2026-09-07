/**
 * `packages/schemas` — zero workspace dependencies by design
 * (workspace-foundation: Dependency Rule Enforcement). It is the
 * foundation package (project.md: "packages/schemas imports nothing").
 * Zod extraction schemas for B2 (ingestion-agent): caratula, cedula and
 * tarjeta_propiedad (docs/ARCHITECTURE.md line 255). `factura` is out of
 * scope. `webhooks/chatwoot.ts` (F2, `@provisional`) is the first webhook/API
 * contract schema. `policy-import-row.ts` (A1, `NEEDS CONFIRMATION` per O1)
 * is the first spreadsheet-import row schema. `extraction-envelope.ts`
 * (`admin-dashboard` C1, `@provisional`, design.md D-E) is the extraction
 * review queue's read-side view schema. `dashboard/correction-request.ts`
 * (C1, design.md D-E) is the review queue's correction-endpoint request
 * body schema.
 */
export const PACKAGE_NAME = "@dirus/schemas" as const;

export * from "./primitives.js";
export * from "./caratula.js";
export * from "./cedula.js";
export * from "./tarjeta-propiedad.js";
export * from "./policy-import-row.js";
export * from "./webhooks/chatwoot.js";
export * from "./auth/magic-link-request.js";
export * from "./extraction-envelope.js";
export * from "./dashboard/correction-request.js";
