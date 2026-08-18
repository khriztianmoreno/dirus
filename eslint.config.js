// @ts-check
import base from "./packages/config/eslint.config.js";

export default [
  ...base,
  {
    ignores: ["**/dist/**", "**/coverage/**", "pnpm-lock.yaml"],
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      globals: {
        module: "writable",
        require: "readonly",
        __dirname: "readonly",
      },
    },
  },
];
