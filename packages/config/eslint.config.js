// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Shared flat ESLint config. Packages import and extend this array:
 *
 *   import base from "@dirus/config/eslint.config.js";
 *   export default [...base, { ...packageSpecificOverrides }];
 */
export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
);

export default base;
