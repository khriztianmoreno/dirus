/**
 * `packages/schemas` — typed shell, zero workspace dependencies by design
 * (workspace-foundation: Dependency Rule Enforcement). It is the
 * foundation package (project.md: "packages/schemas imports nothing").
 * Shared Zod schemas (extraction, webhooks, API contracts) land in later
 * changes.
 */
export const PACKAGE_NAME = "@dirus/schemas" as const;
