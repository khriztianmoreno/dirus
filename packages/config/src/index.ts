/**
 * `packages/config` publishes shared workspace tooling (base tsconfig, flat
 * ESLint config, shared Vitest config) rather than runtime code. This module
 * exists so the package has a typed entrypoint and can be typechecked.
 */
export const CONFIG_PACKAGE_NAME = "@dirus/config" as const;
