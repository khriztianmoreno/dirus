/**
 * Workspace import boundary rules (workspace-foundation: Dependency Rule
 * Enforcement; design.md D-H). Consumed both by the CLI (`pnpm lint:deps`)
 * and programmatically by `packages/config/test/dependency-rule.test.ts`.
 *
 * - `apps/*` MAY import from `packages/*`.
 * - `packages/*` MUST NOT import from `apps/*`.
 * - No app MUST import another app.
 *
 * `packages/schemas` having zero workspace dependencies is a manifest fact
 * (package.json `dependencies`/`devDependencies`), not a module import graph
 * fact, so dependency-cruiser cannot express it — it is asserted separately
 * in the test file by reading `packages/schemas/package.json` directly.
 */
module.exports = {
  forbidden: [
    {
      name: "no-packages-to-apps",
      comment: "packages/* must not import from apps/*",
      severity: "error",
      from: { path: "^packages" },
      to: { path: "^apps" },
    },
    {
      name: "no-app-to-app",
      comment: "no app may import another app",
      severity: "error",
      from: { path: "^apps/([^/]+)" },
      to: { path: "^apps/(?!$1)" },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: "node_modules",
    },
  },
};
