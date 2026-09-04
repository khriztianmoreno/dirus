/**
 * `packages/schemas` — zero workspace dependencies by design
 * (workspace-foundation: Dependency Rule Enforcement). It is the
 * foundation package (project.md: "packages/schemas imports nothing").
 * Zod extraction schemas for B2 (ingestion-agent): caratula, cedula and
 * tarjeta_propiedad (docs/ARCHITECTURE.md line 255). `factura` is out of
 * scope. Webhook/API contract schemas land in later changes.
 */
export const PACKAGE_NAME = "@dirus/schemas" as const;

export * from "./primitives.js";
export * from "./caratula.js";
export * from "./cedula.js";
export * from "./tarjeta-propiedad.js";
